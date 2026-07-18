import type { AgentEvent } from "@piki/agent-core";
import type { AssistantMessage } from "@piki/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { WorkerExecutor } from "../../../src/core/worker-executor.ts";
import { WorkerSession } from "../../../src/core/worker-session.ts";

function createWorkerTestModel() {
	return {
		id: "test-model",
		name: "Test",
		api: "openai-completions",
		provider: "faux",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "faux",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("WorkerSession fork-entry capture (S5/S7/S8)", () => {
	it("emits the initial user/task step in the constructor with forkId and null parent", () => {
		const captured: SessionEntry[] = [];
		const session = new WorkerSession({
			forkId: "fork-1",
			agentId: "agent-1",
			role: "scout",
			model: createWorkerTestModel(),
			systemPrompt: "You are a scout.",
			initialMessage: "Investigate the widget.",
			tools: [],
			contextLimit: 128000,
			onFinished: () => {},
			onError: () => {},
			onForkEntry: (entry) => captured.push(entry),
		});

		expect(captured).toHaveLength(1);
		const [first] = captured;
		expect(first.type).toBe("message");
		expect(first.forkId).toBe("fork-1");
		expect(first.parentId).toBeNull();
		if (first.type === "message") {
			expect(first.message.role).toBe("user");
			expect((first.message as { content: string }).content).toBe("Investigate the widget.");
		}
		session.kill();
	});

	it("materializes user → assistant → toolResult with parent chaining and forkId", async () => {
		const captured: SessionEntry[] = [];
		const session = new WorkerSession({
			forkId: "fork-2",
			agentId: "agent-2",
			role: "scout",
			model: createWorkerTestModel(),
			systemPrompt: "You are a scout.",
			initialMessage: "Investigate.",
			tools: [
				{
					name: "read",
					description: "Read files",
					parameters: Type.Object({ path: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "file" }], details: null }),
				},
			],
			contextLimit: 128000,
			onFinished: () => {},
			onError: () => {},
			onForkEntry: (entry) => captured.push(entry),
		});

		const internals = session as unknown as {
			handleAgentEvent(event: AgentEvent, signal: AbortSignal): Promise<void>;
		};
		const signal = new AbortController().signal;

		const assistant = createAssistantMessage(
			[
				{ type: "text", text: "Looking." },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
			],
			"toolUse",
		);
		await internals.handleAgentEvent({ type: "message_end", message: assistant }, signal);

		const toolResult = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "line1" }],
			isError: false,
			timestamp: Date.now(),
		} as unknown as AssistantMessage;
		await internals.handleAgentEvent({ type: "message_end", message: toolResult }, signal);

		// initial user step + assistant + toolResult
		expect(captured).toHaveLength(3);
		const [user, assistantEntry, toolResultEntry] = captured;
		expect(user.forkId).toBe("fork-2");
		expect(user.parentId).toBeNull();
		expect(assistantEntry.parentId).toBe(user.id);
		expect(assistantEntry.forkId).toBe("fork-2");
		expect(toolResultEntry.parentId).toBe(assistantEntry.id);
		expect(toolResultEntry.forkId).toBe("fork-2");
		if (assistantEntry.type === "message") {
			expect((assistantEntry.message as { stopReason: string }).stopReason).toBe("toolUse");
		}
		session.kill();
	});

	it("marks a failed assistant message with llmFailed (S7)", async () => {
		const captured: SessionEntry[] = [];
		const session = new WorkerSession({
			forkId: "fork-3",
			agentId: "agent-3",
			role: "scout",
			model: createWorkerTestModel(),
			systemPrompt: "You are a scout.",
			initialMessage: "Go.",
			tools: [],
			contextLimit: 128000,
			onFinished: () => {},
			onError: () => {},
			onForkEntry: (entry) => captured.push(entry),
		});

		const internals = session as unknown as {
			handleAgentEvent(event: AgentEvent, signal: AbortSignal): Promise<void>;
		};
		const failed = createAssistantMessage([], "error");
		failed.errorMessage = "boom";
		await internals.handleAgentEvent({ type: "message_end", message: failed }, new AbortController().signal);

		const assistantEntry = captured.find(
			(e) => e.type === "message" && (e as { message: { role: string } }).message.role === "assistant",
		);
		expect(assistantEntry).toBeDefined();
		if (assistantEntry && assistantEntry.type === "message") {
			expect(assistantEntry.llmFailed).toBe(true);
		}
		session.kill();
	});
});

describe("WorkerExecutor fork buffer (S5)", () => {
	it("records and returns per-fork entries; clears only on dispose", () => {
		const executor = new WorkerExecutor({
			resolveModel: () => undefined,
			getAllTools: () => [],
			getProjectContext: () => "",
			getTranscript: () => "",
			publishEvent: async () => {},
			onWorkerFinished: () => {},
			onWorkerError: () => {},
		});

		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "go", timestamp: Date.now() },
				forkId: "fork-x",
			},
		];

		expect(executor.getForkEntries().size).toBe(0);
		executor.recordForkEntry("fork-x", entries[0]!);
		expect(executor.getForkEntries().size).toBe(1);
		expect(executor.getForkEntries().get("fork-x")).toHaveLength(1);

		// cleanupWorker must NOT evict the fork buffer (export runs after finalize)
		const internals = executor as unknown as {
			cleanupWorker(forkId: string, agentId: string): void;
		};
		internals.cleanupWorker("fork-x", "agent-x");
		expect(executor.getForkEntries().size).toBe(1);

		executor.dispose();
		expect(executor.getForkEntries().size).toBe(0);
	});
});
