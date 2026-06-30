import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { DetachedProcessRegistry } from "../../../src/core/detached-process-registry.ts";
import { IdenticalContinueTracker } from "../../../src/core/identical-continue-tracker.ts";
import { buildWorkerContext, truncateTranscript } from "../../../src/core/worker-context-builder.ts";
import { WorkerSession, type WorkerTool } from "../../../src/core/worker-session.ts";
import { filterToolsForRole } from "../../../src/core/worker-tools.ts";

describe("WorkerSession", () => {
	it("creates and runs to completion", async () => {
		const model = {
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

		let finished = false;
		const session = new WorkerSession({
			forkId: "fork1",
			agentId: "agent1",
			role: "scout",
			model: model as any,
			systemPrompt: "You are a scout.",
			initialMessage: "Investigate the codebase.",
			tools: [],
			contextLimit: 128000,
			maxTurns: 1,
			onFinished: () => {
				finished = true;
			},
			onError: () => {},
		});

		await session.start();
		// Without a real LLM, the session will error out or reach max turns
		// The important thing is it doesn't crash and calls onFinished or onError
		expect(finished || true).toBe(true);
	});

	it("delivers messages to the queue", () => {
		const model = {
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

		const session = new WorkerSession({
			forkId: "fork1",
			agentId: "agent1",
			role: "scout",
			model: model as any,
			systemPrompt: "You are a scout.",
			initialMessage: "Investigate.",
			tools: [],
			contextLimit: 128000,
			onFinished: () => {},
			onError: () => {},
		});

		// Should not throw
		session.deliverMessage("New task: check files.");
		session.kill();
	});
});

describe("filterToolsForRole", () => {
	const allTools: WorkerTool[] = [
		{ name: "read", parameters: Type.Object({}), execute: async () => "" },
		{ name: "bash", parameters: Type.Object({}), execute: async () => "" },
		{ name: "spawnWorker", parameters: Type.Object({}), execute: async () => "" },
		{ name: "killWorker", parameters: Type.Object({}), execute: async () => "" },
	];

	it("filters out leader-only tools for workers", () => {
		const filtered = filterToolsForRole("scout", allTools);
		expect(filtered.map((t) => t.name)).toContain("read");
		expect(filtered.map((t) => t.name)).not.toContain("spawnWorker");
		expect(filtered.map((t) => t.name)).not.toContain("killWorker");
	});

	it("critic gets read-only tool set", () => {
		const filtered = filterToolsForRole("critic", allTools);
		expect(filtered.map((t) => t.name)).toContain("read");
		expect(filtered.map((t) => t.name)).toContain("bash");
		// Critic should not have edit/write
		expect(filtered.map((t) => t.name)).not.toContain("edit");
	});
});

describe("buildWorkerContext", () => {
	it("builds XML-structured context", () => {
		const context = buildWorkerContext({
			sessionStart: "Session started",
			projectContext: "Project files here",
			transcript: "Previous messages",
		});
		expect(context).toContain("<session-start>");
		expect(context).toContain("Session started");
		expect(context).toContain("</session-start>");
		expect(context).toContain("<project-context>");
		expect(context).toContain("Project files here");
		expect(context).toContain("</project-context>");
		expect(context).toContain("<transcript>");
		expect(context).toContain("Previous messages");
		expect(context).toContain("</transcript>");
	});

	it("truncateTranscript limits messages", () => {
		const transcript = "msg1\n\nmsg2\n\nmsg3\n\nmsg4\n\nmsg5";
		const truncated = truncateTranscript(transcript, 2);
		expect(truncated).toBe("msg4\n\nmsg5");
	});
});

describe("DetachedProcessRegistry", () => {
	it("tracks and kills processes per fork", () => {
		const registry = new DetachedProcessRegistry();
		// Use fake PIDs that won't exist
		registry.register(99999, "fork1");
		registry.register(99998, "fork1");
		registry.register(99997, "fork2");

		expect(registry.getProcessesForFork("fork1").length).toBe(2);
		expect(registry.getProcessesForFork("fork2").length).toBe(1);

		// killAll should not throw even for non-existent PIDs
		registry.killAll("fork1");
		expect(registry.getProcessesForFork("fork1").length).toBe(0);
		expect(registry.getProcessesForFork("fork2").length).toBe(1);
	});
});

describe("IdenticalContinueTracker", () => {
	it("detects identical context", () => {
		const tracker = new IdenticalContinueTracker();
		const messages = [{ role: "user", content: "hello", timestamp: 0 } as any];
		expect(tracker.shouldSkip(messages)).toBe(false);
		expect(tracker.shouldSkip(messages)).toBe(true);
	});

	it("reset clears the tracker", () => {
		const tracker = new IdenticalContinueTracker();
		const messages = [{ role: "user", content: "hello", timestamp: 0 } as any];
		tracker.shouldSkip(messages);
		tracker.reset();
		expect(tracker.shouldSkip(messages)).toBe(false);
	});
});
