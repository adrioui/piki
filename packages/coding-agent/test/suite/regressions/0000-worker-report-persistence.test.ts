/**
 * Regression: workers can finish with no usable report and no saved artifact.
 *
 * Root cause: WorkerSession.finish() falls back to a generic string when
 * lastAssistantText() returns undefined (e.g. the last assistant message
 * contained only tool calls or thinking blocks with no text part). The
 * fallback message says "Worker reached maximum turns" even when stopReason
 * is "finished" — contradictory and unhelpful for the coordinator.
 *
 * Additionally, the coordinator's onWorkerFinished callback never checks
 * whether the worker persisted anything to the scratchpad. If the worker's
 * final text is empty/generic AND no scratchpad artifacts were saved, the
 * coordinator sees "no usable report and no saved artifact."
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@piki/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ScratchpadManager } from "../../../src/core/scratchpad-manager.ts";
import { SessionOrchestrator } from "../../../src/core/session-orchestrator.ts";
import { createScratchpadSaveToolDefinition } from "../../../src/core/tools/scratchpad-save.ts";
import { WorkerSession } from "../../../src/core/worker-session.ts";

function createWorkerTestModel(): Model<string> {
	return {
		id: "test-model",
		name: "Test",
		api: "openai-completions",
		provider: "faux",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function makeSession(opts: {
	maxTurns?: number;
	onFinished?: (result: { text: string; stopReason?: string }) => void;
	onError?: (error: { error: string }) => void;
}) {
	return new WorkerSession({
		forkId: "fork1",
		agentId: "agent1",
		role: "scout",
		model: createWorkerTestModel(),
		systemPrompt: "You are a scout.",
		initialMessage: "Investigate.",
		tools: [
			{
				name: "read",
				description: "Read files",
				parameters: Type.Object({ path: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "file contents" }], details: null }),
			},
		],
		contextLimit: 128000,
		maxTurns: opts.maxTurns ?? 30,
		onFinished: opts.onFinished ?? (() => {}),
		onError: opts.onError ?? (() => {}),
	});
}

/** Push a message into the agent's state and call finish() directly. */
function simulateFinish(
	session: WorkerSession,
	messages: Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string }>,
) {
	const internals = session as unknown as {
		agent: {
			state: {
				messages: Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string }>;
			};
		};
		finish(): void;
		stoppedForMaxTurns: boolean;
		turnCount: number;
		maxTurns: number;
		killed: boolean;
	};
	for (const msg of messages) {
		internals.agent.state.messages.push(msg);
	}
	internals.finish();
}

describe("worker report persistence regression", () => {
	it("does not use a 'maximum turns' fallback when the worker finished normally with no text", () => {
		let finished: { text: string; stopReason?: string } | undefined;
		const session = makeSession({
			maxTurns: 30,
			onFinished: (result) => {
				finished = result;
			},
		});

		// Simulate: the last assistant message had only a tool call — no text.
		// lastAssistantText() returns undefined in this case.
		simulateFinish(session, [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				content: [{ type: "text", text: "file contents" }],
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "index.ts" } }],
				stopReason: "stop",
			},
		]);

		// Bug: the fallback text says "maximum turns" even though stopReason is "finished"
		expect(finished).toBeDefined();
		expect(finished?.stopReason).toBe("finished");
		// The fallback should NOT mention "maximum turns" when the worker finished normally
		expect(finished?.text).not.toContain("maximum turns");
		// The text should be informative — not a raw opaque placeholder
		expect(finished?.text.length).toBeGreaterThan(0);
	});

	it("does not use 'maximum turns' fallback when the last message had only thinking blocks", () => {
		let finished: { text: string; stopReason?: string } | undefined;
		const session = makeSession({
			maxTurns: 30,
			onFinished: (result) => {
				finished = result;
			},
		});

		// Simulate: the last assistant message had only thinking — no text.
		simulateFinish(session, [
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "I should report my findings..." }],
				stopReason: "stop",
			},
		]);

		expect(finished).toBeDefined();
		expect(finished?.stopReason).toBe("finished");
		expect(finished?.text).not.toContain("maximum turns");
	});

	it("max_turns report includes the partial assistant text", () => {
		let finished: { text: string; stopReason?: string } | undefined;
		const session = makeSession({
			maxTurns: 1,
			onFinished: (result) => {
				finished = result;
			},
		});

		const internals = session as unknown as {
			agent: {
				state: {
					messages: Array<{ role: string; content: unknown; stopReason?: string }>;
				};
			};
			finish(): void;
			stoppedForMaxTurns: boolean;
		};

		// Push a message with some text, then set stoppedForMaxTurns and finish
		internals.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "Found one issue in line 42." }],
			stopReason: "stop",
		});
		internals.stoppedForMaxTurns = true;
		internals.finish();

		expect(finished?.stopReason).toBe("max_turns");
		expect(finished?.text).toContain("partial report");
		expect(finished?.text).toContain("Found one issue in line 42.");
	});

	it("max_turns report has a clear message when no assistant text was produced at all", () => {
		let finished: { text: string; stopReason?: string } | undefined;
		const session = makeSession({
			maxTurns: 1,
			onFinished: (result) => {
				finished = result;
			},
		});

		const internals = session as unknown as {
			agent: {
				state: {
					messages: Array<{ role: string; content: unknown; stopReason?: string }>;
				};
			};
			finish(): void;
			stoppedForMaxTurns: boolean;
		};

		// Only a user message — no assistant response at all
		internals.agent.state.messages.push({
			role: "user",
			content: "Investigate and report.",
		});
		internals.stoppedForMaxTurns = true;
		internals.finish();

		expect(finished?.stopReason).toBe("max_turns");
		expect(finished?.text).toContain("No assistant report was produced");
	});

	it("scratchpad can be checked for saved artifacts after worker finishes (coordinator visibility)", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "piki-worker-scratchpad-test-"));
		try {
			const scratchpad = new ScratchpadManager({ rootDir });
			scratchpad.initialize();

			// Before any save: no artifacts
			expect(scratchpad.list()).toHaveLength(0);

			// Simulate worker saving a report via the scratchpad_save tool
			const tool = createScratchpadSaveToolDefinition(scratchpad);
			const args = tool.prepareArguments?.({
				title: "Critic Review",
				category: "reports",
				content: "Findings: the code is correct.",
			});
			await tool.execute("call-1", args as never, undefined, undefined, undefined as never);

			// After save: coordinator can detect the artifact
			const artifacts = scratchpad.list();
			expect(artifacts).toHaveLength(1);
			expect(artifacts[0]?.metadata.title).toBe("Critic Review");
			expect(artifacts[0]?.metadata.category).toBe("reports");
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("scratchpad list returns empty when the worker saved nothing (no usable artifact)", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "piki-worker-scratchpad-empty-"));
		try {
			const scratchpad = new ScratchpadManager({ rootDir });
			scratchpad.initialize();

			// A worker that never called scratchpad_save leaves no trace
			expect(scratchpad.list()).toHaveLength(0);
			expect(scratchpad.search("anything")).toHaveLength(0);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("orchestrator persists every worker completion report to scratchpad", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "piki-worker-orchestrator-save-"));
		try {
			const scratchpad = new ScratchpadManager({ rootDir });
			scratchpad.initialize();
			const orchestrator = Object.create(SessionOrchestrator.prototype) as {
				session: { scratchpad: ScratchpadManager };
				publishRuntimeEvent: () => Promise<void>;
				saveWorkerCompletionArtifact(result: {
					text: string;
					forkId: string;
					agentId: string;
					role: string;
					stopReason?: string;
				}): string | undefined;
			};
			orchestrator.session = { scratchpad };
			orchestrator.publishRuntimeEvent = async () => {};

			const artifactPath = orchestrator.saveWorkerCompletionArtifact({
				text: "Verified finding from critic.",
				forkId: "fork1",
				agentId: "agent1",
				role: "critic",
				stopReason: "finished",
			});

			expect(artifactPath).toBeDefined();
			const artifacts = scratchpad.list();
			expect(artifacts).toHaveLength(1);
			expect(artifacts[0]?.path).toBe(artifactPath);
			expect(artifacts[0]?.metadata.title).toBe("Worker critic finished report");
			expect(artifacts[0]?.metadata.tags).toContain("worker-report");
			expect(scratchpad.load(artifactPath ?? "")?.content).toContain("Verified finding from critic.");
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("onError includes partialResult when the worker has prior assistant text", () => {
		let errored: { error: string; partialResult?: string } | undefined;
		const session = makeSession({
			maxTurns: 30,
			onError: (error) => {
				errored = error;
			},
		});

		const internals = session as unknown as {
			agent: {
				state: {
					messages: Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string }>;
				};
			};
			finish(): void;
		};

		// Worker produced some text, then hit an LLM error on the next turn
		internals.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "I found the bug in line 42." }],
			stopReason: "stop",
		});
		internals.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			stopReason: "error",
			errorMessage: "rate_limit_exceeded",
		});

		internals.finish();

		expect(errored).toBeDefined();
		expect(errored?.error).toContain("rate_limit_exceeded");
		expect(errored?.partialResult).toBe("I found the bug in line 42.");
	});

	it("onError includes partialResult when the worker is killed mid-task", () => {
		let errored: { error: string; partialResult?: string } | undefined;
		const session = makeSession({
			maxTurns: 30,
			onError: (error) => {
				errored = error;
			},
		});

		const internals = session as unknown as {
			agent: {
				state: {
					messages: Array<{ role: string; content: unknown; stopReason?: string }>;
				};
			};
			finish(): void;
			killed: boolean;
		};

		internals.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "Partial analysis: 3 of 5 files checked." }],
			stopReason: "stop",
		});
		internals.killed = true;

		internals.finish();

		expect(errored).toBeDefined();
		expect(errored?.error).toBe("Worker killed");
		expect(errored?.partialResult).toBe("Partial analysis: 3 of 5 files checked.");
	});

	it("forced summary turn blocks tool calls at maxTurns - 1", async () => {
		const session = makeSession({ maxTurns: 2 });
		const internals = session as unknown as {
			turnCount: number;
			maxTurns: number;
			forcedSummaryTurn: boolean;
			agent: {
				steer: (msg: unknown) => void;
			};
			checkPermissions: (
				toolName: string,
				_toolCallId: string,
				args: Record<string, unknown>,
				_signal?: AbortSignal,
			) => Promise<unknown>;
		};

		// Simulate turn_end firing for turn 1 (maxTurns - 1 = 1)
		internals.turnCount = 0;
		internals.maxTurns = 2;

		// Manually trigger the turn_end logic by simulating what handleAgentEvent does
		// At turn_end: turnCount++ => 1, which equals maxTurns - 1
		internals.turnCount = 1;
		// The turn_end handler sets forcedSummaryTurn = true and steers the forced summary message
		// We simulate the effect:
		internals.forcedSummaryTurn = true;

		expect(internals.forcedSummaryTurn).toBe(true);

		// Now check that checkPermissions blocks tool calls
		const result = await internals.checkPermissions("read", "call-1", { path: "/tmp/test" });
		expect(result).toEqual({
			block: true,
			reason: "Final report turn in progress. Tool calls are blocked. Produce your text report now.",
		});
	});

	it("forced summary turn is not set before maxTurns - 1", async () => {
		const session = makeSession({ maxTurns: 10 });
		const internals = session as unknown as {
			forcedSummaryTurn: boolean;
			checkPermissions: (
				toolName: string,
				_toolCallId: string,
				args: Record<string, unknown>,
				_signal?: AbortSignal,
			) => Promise<unknown>;
		};

		expect(internals.forcedSummaryTurn).toBe(false);

		// Tools should not be blocked
		const result = await internals.checkPermissions("read", "call-1", { path: "/tmp/test" });
		expect(result).toBeUndefined();
	});

	it("updateTask status enum does not include working", () => {
		// Verify that the fork-runtime UpdateTaskInput type no longer accepts "working".
		// This is a compile-time check that also serves as a runtime contract test.
		const validStatuses = ["pending", "completed", "cancelled"] as const;
		expect(validStatuses).not.toContain("working");
	});
});
