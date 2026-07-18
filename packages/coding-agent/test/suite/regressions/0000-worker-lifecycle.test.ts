import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentMessage } from "@piki/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@piki/ai";
import { ARTISAN_PROMPT, COORDINATOR_ON_SPAWN, LEADER_PROMPT } from "@piki/roles";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { DetachedProcessRegistry } from "../../../src/core/detached-process-registry.ts";
import { IdenticalContinueTracker } from "../../../src/core/identical-continue-tracker.ts";
import { ScratchpadManager } from "../../../src/core/scratchpad-manager.ts";
import { createScratchpadSaveToolDefinition } from "../../../src/core/tools/scratchpad-save.ts";
import { buildWorkerContext } from "../../../src/core/worker-context-builder.ts";
import { WorkerExecutor } from "../../../src/core/worker-executor.ts";
import { WorkerSession, type WorkerTool } from "../../../src/core/worker-session.ts";
import { filterToolsForRole } from "../../../src/core/worker-tools.ts";

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
		let errored = false;
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
			onError: () => {
				errored = true;
			},
		});

		await session.start();
		// Without a real LLM, the session will error out or reach max turns
		// The important thing is it doesn't crash and calls onFinished or onError
		expect(finished || errored).toBe(true);
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

	it("marks invalid worker tool-call streams with corrective validation feedback", async () => {
		const publishEvents: string[] = [];
		const session = new WorkerSession({
			forkId: "fork1",
			agentId: "agent1",
			role: "scout",
			model: createWorkerTestModel(),
			systemPrompt: "You are a scout.",
			initialMessage: "Read the file.",
			tools: [
				{
					name: "read",
					description: "Read files",
					parameters: Type.Object({ path: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "file" }], details: null }),
				},
			],
			contextLimit: 128000,
			maxTurns: 5,
			publishEvent: async (type) => {
				publishEvents.push(type);
			},
			onFinished: () => {},
			onError: () => {},
		});

		const partial = createAssistantMessage(
			[{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
			"toolUse",
		);
		const internals = session as unknown as {
			handleAgentEvent(event: AgentEvent, signal: AbortSignal): Promise<void>;
		};

		await internals.handleAgentEvent(
			{
				type: "message_update",
				message: partial,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: '{"path":123}',
					partial,
				},
			},
			new AbortController().signal,
		);

		const aborted = createAssistantMessage(partial.content, "aborted");
		await internals.handleAgentEvent({ type: "message_end", message: aborted }, new AbortController().signal);

		expect(aborted.stopReason).toBe("error");
		expect(aborted.errorMessage).toContain("tool_validation:");
		expect(publishEvents).toContain("tool_validation_failed");
	});

	it("defers unknown-field streaming failures for worker tools with prepareArguments", async () => {
		const publishEvents: string[] = [];
		const session = new WorkerSession({
			forkId: "fork1",
			agentId: "agent1",
			role: "scout",
			model: createWorkerTestModel(),
			systemPrompt: "You are a scout.",
			initialMessage: "Edit the file.",
			tools: [
				{
					name: "edit",
					description: "Edit files",
					parameters: Type.Object({ path: Type.String() }),
					prepareArguments: (args) => args,
					execute: async () => ({ content: [{ type: "text", text: "edited" }], details: null }),
				},
			],
			contextLimit: 128000,
			maxTurns: 5,
			publishEvent: async (type) => {
				publishEvents.push(type);
			},
			onFinished: () => {},
			onError: () => {},
		});

		const partial = createAssistantMessage(
			[{ type: "toolCall", id: "call-1", name: "edit", arguments: {} }],
			"toolUse",
		);
		const internals = session as unknown as {
			handleAgentEvent(event: AgentEvent, signal: AbortSignal): Promise<void>;
		};

		await internals.handleAgentEvent(
			{
				type: "message_update",
				message: partial,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: '{"path":"file.ts","unexpected":"value"}',
					partial,
				},
			},
			new AbortController().signal,
		);

		expect(publishEvents).not.toContain("tool_validation_failed");
	});

	it("returns a partial report instead of an opaque error at max turns", async () => {
		let finished:
			| {
					text: string;
					stopReason?: string;
			  }
			| undefined;
		let errored = false;
		const session = new WorkerSession({
			forkId: "fork1",
			agentId: "agent1",
			role: "scout",
			model: createWorkerTestModel(),
			systemPrompt: "You are a scout.",
			initialMessage: "Investigate and report.",
			tools: [],
			contextLimit: 128000,
			maxTurns: 1,
			streamFn: () =>
				new MockAssistantStream(
					createAssistantMessage([{ type: "text", text: "Partial evidence: inspected README.md." }], "stop"),
				),
			onFinished: (result) => {
				finished = result;
			},
			onError: () => {
				errored = true;
			},
		});

		await session.start();

		expect(errored).toBe(false);
		expect(finished?.stopReason).toBe("max_turns");
		expect(finished?.text).toContain("partial report");
		expect(finished?.text).toContain("Partial evidence");
	});

	it("does not retry tool validation after the max-turn limit is reached", () => {
		const session = new WorkerSession({
			forkId: "fork1",
			agentId: "agent1",
			role: "scout",
			model: createWorkerTestModel(),
			systemPrompt: "You are a scout.",
			initialMessage: "Investigate and report.",
			tools: [],
			contextLimit: 128000,
			maxTurns: 1,
			onFinished: () => {},
			onError: () => {},
		});

		const validationError = createAssistantMessage([{ type: "text", text: "bad args" }], "error");
		validationError.errorMessage = "tool_validation: Invalid field";

		const internals = session as unknown as {
			stoppedForMaxTurns: boolean;
			shouldRetryToolValidation(): boolean;
			agent: { state: { messages: AgentMessage[] } };
		};
		internals.agent.state.messages.push(validationError);
		internals.stoppedForMaxTurns = true;

		expect(internals.shouldRetryToolValidation()).toBe(false);
	});
});

describe("worker coordination prompts", () => {
	it("describes delegation and worker-based outsourcing", () => {
		expect(LEADER_PROMPT).toContain("a highly capable coding agent");
		expect(LEADER_PROMPT).toContain("Workers are used to outsource work of any kind");
		expect(LEADER_PROMPT).toContain("time and token-efficient");
	});

	it("caps thinking fragments using mag-equivalent dynamic wording while preserving the 7-fragment policy", () => {
		expect(LEADER_PROMPT).toContain("the total number of available fragments");
		expect(LEADER_PROMPT).toContain("6 metacognitive + 1 task");
	});

	it("does not nudge bounded scout or engineer work into extra worker waves", () => {
		expect(COORDINATOR_ON_SPAWN.scout).toContain("other areas to investigate");
		expect(COORDINATOR_ON_SPAWN.engineer).toContain("other independent changes");
	});

	it("tells artisan workers to craft polished non-code deliverables", () => {
		expect(ARTISAN_PROMPT).toContain("non-code deliverables");
		expect(ARTISAN_PROMPT).toContain("documentation, configuration, scripts");
	});
});

describe("scratchpad_save", () => {
	it("canonicalizes common category aliases before saving", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "piki-scratchpad-test-"));
		try {
			const scratchpad = new ScratchpadManager({ rootDir });
			const tool = createScratchpadSaveToolDefinition(scratchpad);
			const args = tool.prepareArguments?.({
				title: "Source approval critique",
				category: "analysis",
				content: "findings",
			});

			expect(args).toMatchObject({ category: "reports" });
			const result = await tool.execute("call-1", args as never, undefined, undefined, undefined as never);
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("to reports:");
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});

describe("WorkerExecutor", () => {
	it("does not clean up a killed worker before its session settles", async () => {
		let killed = false;
		const executor = new WorkerExecutor({
			resolveModel: () => undefined,
			getAllTools: () => [],
			getProjectContext: () => "",
			getTranscript: () => "",
			publishEvent: async () => {},
			onWorkerFinished: () => {},
			onWorkerError: () => {},
		});
		const internals = executor as unknown as {
			workers: Map<string, { kill(): void }>;
			onWorkerKilled(event: { payload: { agentId: string; forkId: string } }): Promise<void>;
		};
		internals.workers.set("agent1", {
			kill: () => {
				killed = true;
			},
		});

		await internals.onWorkerKilled({ payload: { agentId: "agent1", forkId: "fork1" } });

		expect(killed).toBe(true);
		expect(internals.workers.has("agent1")).toBe(true);
		executor.dispose();
	});
});

describe("filterToolsForRole", () => {
	const allTools: WorkerTool[] = [
		{
			name: "read",
			description: "Read files",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "" }], details: null }),
		},
		{
			name: "bash",
			description: "Run shell commands",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "" }], details: null }),
		},
		{
			name: "shell",
			description: "Run shell commands",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "" }], details: null }),
		},
		{
			name: "grep",
			description: "Hidden search",
			parameters: Type.Object({}),
			hidden: true,
			execute: async () => ({ content: [{ type: "text", text: "" }], details: null }),
		},
		{
			name: "spawn_worker",
			description: "Spawn a worker",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "" }], details: null }),
		},
		{
			name: "kill_worker",
			description: "Kill a worker",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "" }], details: null }),
		},
	];

	it("filters out leader-only tools for workers", () => {
		const filtered = filterToolsForRole("scout", allTools);
		expect(filtered.map((t) => t.name)).toContain("read");
		expect(filtered.map((t) => t.name)).not.toContain("spawn_worker");
		expect(filtered.map((t) => t.name)).not.toContain("kill_worker");
	});

	it("omits hidden tools unless explicitly requested", () => {
		expect(filterToolsForRole("scout", allTools).map((t) => t.name)).not.toContain("grep");
		expect(filterToolsForRole("scout", allTools, { includeHidden: true }).map((t) => t.name)).toContain("grep");
	});

	it("critic gets read-only tool set", () => {
		const filtered = filterToolsForRole("critic", allTools);
		expect(filtered.map((t) => t.name)).toContain("read");
		expect(filtered.map((t) => t.name)).toContain("shell");
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
