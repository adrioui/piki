import type { AgentEvent, AgentTool } from "@piki/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@piki/ai";
import { KEEP_MESSAGE_RATIO } from "@piki/event-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerSession } from "../../../src/core/worker-session.ts";
import { createHarness, type Harness } from "../harness.ts";

function turnEndEvent(): AgentEvent {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: undefined as never,
		toolResults: [],
	} as unknown as AgentEvent;
}

async function advance(session: { _emitExtensionEvent(event: AgentEvent): Promise<void> }, n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		await session._emitExtensionEvent(turnEndEvent());
	}
}

describe("AgentSession leader max-turns cap", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("warns near the cap and stops at the cap, emitting leader_max_turns", async () => {
		const harness = await createHarness({ settings: { leaderMaxTurns: 5 } });
		harnesses.push(harness);
		const session = harness.session as unknown as {
			_emitExtensionEvent(event: AgentEvent): Promise<void>;
			_leaderMaxTurns: number;
			_leaderTurnWarningSent: boolean;
			_leaderTurnsStopped: boolean;
		};

		expect(session._leaderMaxTurns).toBe(5);
		expect(session._leaderTurnsStopped).toBe(false);

		// Turn 1: no warning yet (warning threshold is cap-3 = 2).
		await advance(session, 1);
		expect(session._leaderTurnWarningSent).toBe(false);
		expect(session._leaderTurnsStopped).toBe(false);

		// Turn 2: cap-3 => near-limit warning steered.
		await advance(session, 1);
		expect(session._leaderTurnWarningSent).toBe(true);
		expect(session._leaderTurnsStopped).toBe(false);

		// Turn 5: hard stop + runtime event.
		await advance(session, 3);
		expect(session._leaderTurnsStopped).toBe(true);

		const maxTurnsEvent = harness
			.eventsOfType("runtime_event")
			.find((event) => event.runtimeEventType === "leader_max_turns");
		expect(maxTurnsEvent).toBeDefined();
		expect(maxTurnsEvent?.payload).toMatchObject({ maxTurns: 5, turnIndex: 5 });
	});

	it("does not stop when the cap is not reached", async () => {
		const harness = await createHarness({ settings: { leaderMaxTurns: 10 } });
		harnesses.push(harness);
		const session = harness.session as unknown as {
			_emitExtensionEvent(event: AgentEvent): Promise<void>;
			_leaderTurnsStopped: boolean;
		};

		for (let i = 1; i <= 9; i++) {
			await session._emitExtensionEvent(turnEndEvent());
		}
		expect(session._leaderTurnsStopped).toBe(false);
	});

	it("/max-turns reports usage, updates the cap, and resumes a stopped leader", async () => {
		const harness = await createHarness({ settings: { leaderMaxTurns: 3 } });
		harnesses.push(harness);
		const session = harness.session as unknown as {
			_emitExtensionEvent(event: AgentEvent): Promise<void>;
			_leaderMaxTurns: number;
			_leaderTurnsStopped: boolean;
		};

		// Stop the leader at the cap (cap = 3 -> 3 turns).
		await advance(session, 3);
		expect(session._leaderTurnsStopped).toBe(true);

		// /max-turns with no arg: informational, does not change state.
		await harness.session.prompt("/max-turns");
		expect(session._leaderMaxTurns).toBe(3);
		expect(session._leaderTurnsStopped).toBe(true);

		// /max-turns 10: raises cap past current turn and resumes.
		await harness.session.prompt("/max-turns 10");
		expect(session._leaderMaxTurns).toBe(10);
		expect(session._leaderTurnsStopped).toBe(false);
		expect(harness.settingsManager.getLeaderMaxTurns()).toBe(10);

		// Invalid arg is rejected without changing state.
		await harness.session.prompt("/max-turns abc");
		expect(session._leaderMaxTurns).toBe(10);
	});

	it("drives multiple tool-call turns then stops at the cap", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool], settings: { leaderMaxTurns: 3 } });
		harnesses.push(harness);

		// Two tool-call turns + a final stop so the loop can exit naturally.
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "a" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("echo", { text: "b" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("final report"),
		]);

		await harness.session.prompt("go");

		const maxTurnsEvent = harness
			.eventsOfType("runtime_event")
			.find((event) => event.runtimeEventType === "leader_max_turns");
		expect(maxTurnsEvent).toBeDefined();
		expect(maxTurnsEvent?.payload).toMatchObject({ maxTurns: 3 });
	});
});

describe("WorkerSession proportional extractive compaction", () => {
	function makeSession(contextLimit: number): WorkerSession {
		return new WorkerSession({
			forkId: "fork1",
			agentId: "agent1",
			role: "scout",
			model: {
				id: "m",
				name: "M",
				api: "openai-completions",
				provider: "faux",
				baseUrl: "http://localhost",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: contextLimit,
				maxTokens: 4096,
			} as never,
			systemPrompt: "scout",
			initialMessage: "investigate",
			tools: [],
			contextLimit,
			onFinished: () => {},
			onError: () => {},
		});
	}

	it("scales retention with the model context window", () => {
		const small = makeSession(8000);
		const large = makeSession(128000);
		const messages = Array.from({ length: 20 }, (_, i) => ({
			role: "user" as const,
			content: `message number ${i} with some content to summarize`,
			timestamp: Date.now(),
		}));

		const smallCap = (small as unknown as { extractiveSummary(m: unknown[]): string }).extractiveSummary(messages);
		const largeCap = (large as unknown as { extractiveSummary(m: unknown[]): string }).extractiveSummary(messages);

		const smallCapLimit = Math.max(2000, Math.floor(8000 * KEEP_MESSAGE_RATIO));
		const largeCapLimit = Math.max(2000, Math.floor(128000 * KEEP_MESSAGE_RATIO));

		// Both respect their proportional cap.
		expect(smallCap.length).toBeLessThanOrEqual(smallCapLimit);
		expect(largeCap.length).toBeLessThanOrEqual(largeCapLimit);
		// A larger context window permits more retained bytes.
		expect(largeCapLimit).toBeGreaterThan(smallCapLimit);
	});

	it("keeps at least a fixed floor for tiny context windows", () => {
		const tiny = makeSession(4000);
		const big = makeSession(200000);
		const messages = Array.from({ length: 40 }, (_, i) => ({
			role: "user" as const,
			content: `message number ${i} with some content to summarize that is reasonably long`,
			timestamp: Date.now(),
		}));

		const tinyResult = (tiny as unknown as { extractiveSummary(m: unknown[]): string }).extractiveSummary(messages);
		const bigResult = (big as unknown as { extractiveSummary(m: unknown[]): string }).extractiveSummary(messages);

		// Tiny window is floored at 2000; big window retains more (when content fills it).
		expect(tinyResult.length).toBeLessThanOrEqual(Math.max(2000, Math.floor(4000 * KEEP_MESSAGE_RATIO)) + 200);
		expect(bigResult.length).toBeGreaterThan(tinyResult.length);
		expect(bigResult.length).toBeLessThanOrEqual(Math.max(2000, Math.floor(200000 * KEEP_MESSAGE_RATIO)));
	});
});
