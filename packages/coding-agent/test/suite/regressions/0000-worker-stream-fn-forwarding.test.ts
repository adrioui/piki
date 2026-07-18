import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@piki/ai";
import { describe, expect, it } from "vitest";
import { WorkerExecutor } from "../../../src/core/worker-executor.ts";

/**
 * Regression: spawned workers (critic/architect/scientist/...) threw
 * `No API key for provider: <provider>` because WorkerExecutor never forwarded
 * the leader's streamFn to WorkerSession. Workers fell back to bare streamSimple,
 * which has no API key resolution. The fix forwards `streamFn` through the worker
 * spawn path so workers reuse the leader's key-resolving streamFn.
 */

function createWorkerTestModel(provider = "inference-net"): Model<string> {
	return {
		id: "glm-5.2",
		name: "GLM-5.2",
		api: "openai-completions",
		provider,
		baseUrl: "https://api.inference.net/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 195000,
		maxTokens: 8192,
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
		provider: "inference-net",
		model: "glm-5.2",
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

interface AgentCreatedPayload {
	forkId: string;
	agentId: string;
	role: string;
	context?: string;
	message?: string;
	mode?: string;
}

function spawnCritic(executor: WorkerExecutor, forkId: string, agentId: string): Promise<void> {
	const internals = executor as unknown as {
		onAgentCreated(event: { payload: AgentCreatedPayload }): Promise<void>;
	};
	return internals.onAgentCreated({
		payload: { forkId, agentId, role: "critic", mode: "spawn", message: "Review the change." },
	});
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
	return Promise.race([
		p,
		new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
	]);
}

describe("WorkerExecutor streamFn forwarding", () => {
	it("forwards the leader's streamFn to spawned workers so they can resolve API keys", async () => {
		const model = createWorkerTestModel("inference-net");
		let streamFnCalled = false;
		let capturedProvider: string | undefined;
		// Mirror the leader's streamFn (sdk.ts): it resolves the key itself per call
		// and does not rely on options.apiKey. Recording the call proves the worker
		// used this streamFn rather than bare streamSimple.
		const streamFn = (m: Model<string>): MockAssistantStream => {
			streamFnCalled = true;
			capturedProvider = m.provider;
			return new MockAssistantStream(createAssistantMessage([{ type: "text", text: "review complete" }], "stop"));
		};

		let finished: { text: string; stopReason?: string } | undefined;
		let errored: { error: string } | undefined;
		let resolveSettled: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});

		const executor = new WorkerExecutor({
			resolveModel: () => model,
			streamFn,
			getAllTools: () => [],
			getProjectContext: () => "",
			getTranscript: () => "",
			publishEvent: async () => {},
			onWorkerFinished: (result) => {
				finished = { text: result.text, stopReason: result.stopReason };
				resolveSettled!();
			},
			onWorkerError: (error) => {
				errored = { error: error.error };
				resolveSettled!();
			},
		});

		await spawnCritic(executor, "fork1", "agent1");
		await withTimeout(settled, 2000);

		expect(errored).toBeUndefined();
		expect(streamFnCalled).toBe(true);
		expect(capturedProvider).toBe("inference-net");
		expect(finished?.text).toContain("review complete");

		executor.dispose();
	});

	it("without streamFn (pre-fix behavior), workers fall back to bare streamSimple and throw", async () => {
		const model = createWorkerTestModel("inference-net");
		const streamFnCalled = false;

		let finished: { text: string } | undefined;
		let errored: { error: string } | undefined;
		let resolveSettled: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});

		// No streamFn forwarded — simulates the pre-fix WorkerExecutor behavior.
		const executor = new WorkerExecutor({
			resolveModel: () => model,
			getAllTools: () => [],
			getProjectContext: () => "",
			getTranscript: () => "",
			publishEvent: async () => {},
			onWorkerFinished: (result) => {
				finished = { text: result.text };
				resolveSettled!();
			},
			onWorkerError: (error) => {
				errored = { error: error.error };
				resolveSettled!();
			},
		});

		await spawnCritic(executor, "fork2", "agent2");
		await withTimeout(settled, 2000);

		// Without forwarding, bare streamSimple throws "No API key for provider: inference-net"
		// and the custom streamFn is never reached. This reproduces the user's error.
		expect(streamFnCalled).toBe(false);
		expect(errored?.error).toContain("No API key for provider: inference-net");
		expect(finished).toBeUndefined();

		executor.dispose();
	});
});
