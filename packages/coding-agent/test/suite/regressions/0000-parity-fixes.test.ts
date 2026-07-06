import type { AgentMessage, StreamFn } from "@piki/agent-core";
import type { Model } from "@piki/ai";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, registerFauxProvider } from "@piki/ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ForkRuntime } from "../../../src/core/fork-runtime.ts";
import { WorkerExecutor } from "../../../src/core/worker-executor.ts";
import { WorkerSession, type WorkerTool } from "../../../src/core/worker-session.ts";

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

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => {
			const reason =
				message.stopReason === "length" || message.stopReason === "toolUse" ? message.stopReason : "stop";
			this.push({ type: "done", reason, message });
		});
	}
}

/** Minimal model for WorkerSession tests that supply their own streamFn. */
function createInlineModel(): Model<string> {
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

const tracked: { unregister?: () => void; dispose?: () => void } = {};
afterEach(() => {
	tracked.unregister?.();
	tracked.dispose?.();
	tracked.unregister = undefined;
	tracked.dispose = undefined;
});

async function waitFor(fn: () => void, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			fn();
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 10));
		}
	}
	fn();
}

// ─── FIX 1.2: a message steered into an active worker loop is processed ───

describe("FIX 1.2 — messageWorker race / worker re-trigger", () => {
	it("processes a message delivered during an active worker turn", async () => {
		const calls: AgentMessage[][] = [];
		let callCount = 0;
		const streamFn = ((_model, context) => {
			callCount += 1;
			calls.push(context.messages.map((m) => ({ ...m })) as AgentMessage[]);
			const msg =
				callCount === 1
					? createAssistantMessage([{ type: "toolCall", id: "call-1", name: "echo", arguments: {} }], "toolUse")
					: createAssistantMessage([{ type: "text", text: "all done" }], "stop");
			return new MockAssistantStream(msg);
		}) as StreamFn;

		let finished = false;
		let errored = false;
		let session: WorkerSession;

		const echoTool: WorkerTool = {
			name: "echo",
			description: "echo",
			parameters: Type.Object({}),
			execute: async () => {
				// Steer a follow-up message while the loop is mid-turn (between tool
				// execution and the next LLM call). The agent loop must drain it and
				// process it in turn 2 rather than dropping it.
				session.deliverMessage("FOLLOW_UP_CONTEXT");
				return { content: [{ type: "text", text: "ok" }], details: null };
			},
		};

		session = new WorkerSession({
			forkId: "fork1",
			agentId: "agent1",
			role: "scout",
			model: createInlineModel(),
			systemPrompt: "You are a scout.",
			initialMessage: "Investigate.",
			tools: [echoTool],
			contextLimit: 128000,
			maxTurns: 5,
			streamFn,
			onFinished: () => {
				finished = true;
			},
			onError: () => {
				errored = true;
			},
		});

		await session.start();

		expect(errored).toBe(false);
		expect(finished).toBe(true);
		expect(callCount).toBeGreaterThanOrEqual(2);
		// The follow-up must have reached the second turn's context.
		const turn2 = calls[1];
		expect(turn2?.some((m) => JSON.stringify(m).includes("FOLLOW_UP_CONTEXT"))).toBe(true);
	});
});

// ─── FIX 1.3 / 2.1 / 2.2: ForkRuntime event publishing ───

function createForkRuntime(): {
	runtime: ForkRuntime;
	events: { type: string; payload: Record<string, unknown> }[];
} {
	const events: { type: string; payload: Record<string, unknown> }[] = [];
	const runtime = new ForkRuntime({
		sessionId: "session-1",
		publish: async (type, payload) => {
			events.push({ type, payload });
		},
		getSequence: () => events.length,
		resolveModel: (role) => ({ provider: "faux", id: `${role}-model` }),
	});
	return { runtime, events };
}

describe("FIX 2.1 / 2.2 — ForkRuntime fork lifecycle events", () => {
	it("publishes fork_created when spawning a worker", async () => {
		const { runtime, events } = createForkRuntime();
		const { agentId } = await runtime.spawnWorker({ role: "scout", message: "go" });
		const created = events.find((e) => e.type === "fork_created");
		expect(created?.payload).toMatchObject({ agentId, role: "scout", parentForkId: "session-1" });
	});

	it("publishes worker_killed when killing a worker", async () => {
		const { runtime, events } = createForkRuntime();
		const { agentId } = await runtime.spawnWorker({ role: "scout" });
		events.length = 0;
		await runtime.killWorker({ workerId: agentId, reason: "done" });
		const killed = events.find((e) => e.type === "worker_killed");
		expect(killed?.payload).toMatchObject({ agentId, reason: "done" });
	});
});

describe("FIX 1.3 — reassignWorker kills the previously assigned worker", () => {
	it("kills the old worker and records the new assignment", async () => {
		const { runtime, events } = createForkRuntime();
		const { agentId: scoutA } = await runtime.spawnWorker({ role: "scout", taskId: "t1" });
		const { agentId: scoutB } = await runtime.spawnWorker({ role: "scout" });
		events.length = 0;

		await runtime.reassignWorker({ taskId: "t1", workerId: scoutB });

		const oldKilled = events.find((e) => e.type === "worker_killed" && e.payload.agentId === scoutA);
		expect(oldKilled?.payload).toMatchObject({ agentId: scoutA, reason: "reassigned to new worker" });

		const oldFinished = events.find((e) => e.type === "agent_finished" && e.payload.agentId === scoutA);
		expect(oldFinished?.payload).toMatchObject({ killed: true, stopReason: "killed" });

		const assigned = events.find((e) => e.type === "task.assigned");
		expect(assigned?.payload).toMatchObject({ taskId: "t1", assignee: scoutB });
	});

	it("reassigning to the same worker does not kill it", async () => {
		const { runtime, events } = createForkRuntime();
		const { agentId } = await runtime.spawnWorker({ role: "scout", taskId: "t1" });
		events.length = 0;

		await runtime.reassignWorker({ taskId: "t1", workerId: agentId });

		expect(events.some((e) => e.type === "worker_killed")).toBe(false);
		expect(events.some((e) => e.type === "task.assigned")).toBe(true);
	});
});

// ─── FIX 2.1: WorkerExecutor emits fork_cleaned ───

describe("FIX 2.1 — WorkerExecutor emits fork_cleaned", () => {
	it("emits fork_cleaned with reason 'finished' when a worker completes", async () => {
		const faux = registerFauxProvider({});
		tracked.unregister = faux.unregister;
		faux.setResponses([createAssistantMessage([{ type: "text", text: "done" }], "stop")]);
		const model = faux.getModel();

		const events: { type: string; payload: Record<string, unknown> }[] = [];
		const executor = new WorkerExecutor({
			resolveModel: () => model,
			getSystemPrompt: () => "You are a scout.",
			getAllTools: () => [],
			getProjectContext: () => "",
			getTranscript: () => "",
			publishEvent: async (type, payload) => {
				events.push({ type, payload: { ...payload } });
			},
			onWorkerFinished: () => {},
			onWorkerError: () => {},
		});
		tracked.dispose = () => executor.dispose();

		const internals = executor as unknown as {
			onAgentCreated(event: { payload: Record<string, unknown> }): Promise<void>;
		};
		await internals.onAgentCreated({
			payload: { forkId: "f1", agentId: "a1", role: "scout", mode: "spawn", message: "do it" },
		});

		await waitFor(() => {
			expect(events.some((e) => e.type === "fork_cleaned")).toBe(true);
		});

		const cleaned = events.find((e) => e.type === "fork_cleaned");
		expect(cleaned?.payload).toMatchObject({ forkId: "f1", agentId: "a1", reason: "finished" });
	});

	it("preserves worker stopReason when reporting worker completion", async () => {
		const faux = registerFauxProvider({});
		tracked.unregister = faux.unregister;
		faux.setResponses([createAssistantMessage([{ type: "text", text: "done" }], "stop")]);
		const model = faux.getModel();

		let finished: { stopReason?: string } | undefined;
		const executor = new WorkerExecutor({
			resolveModel: () => model,
			getSystemPrompt: () => "You are a scout.",
			getAllTools: () => [],
			getProjectContext: () => "",
			getTranscript: () => "",
			publishEvent: async () => {},
			onWorkerFinished: (result) => {
				finished = result;
			},
			onWorkerError: () => {},
		});
		tracked.dispose = () => executor.dispose();

		const internals = executor as unknown as {
			onAgentCreated(event: { payload: Record<string, unknown> }): Promise<void>;
		};
		await internals.onAgentCreated({
			payload: { forkId: "f1", agentId: "a1", role: "scout", mode: "spawn", message: "do it" },
		});

		await waitFor(() => {
			expect(finished?.stopReason).toBe("finished");
		});
	});
});
