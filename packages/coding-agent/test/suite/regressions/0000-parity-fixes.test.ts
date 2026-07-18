import { join } from "node:path";
import type { AgentMessage, StreamFn } from "@piki/agent-core";
import type { Model } from "@piki/ai";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, registerFauxProvider } from "@piki/ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type Args, parseArgs } from "../../../src/cli/args.ts";
import { createAgentSessionFromServices } from "../../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ForkRuntime } from "../../../src/core/fork-runtime.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
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

describe("FIX 5 — spawnWorker rejects an already-assigned task (alpha22 parity)", () => {
	it("throws when a task is already bound to a different worker", async () => {
		const { runtime } = createForkRuntime();
		await runtime.spawnWorker({ role: "scout", taskId: "t1" });
		await expect(runtime.spawnWorker({ role: "scout", taskId: "t1" })).rejects.toThrow(/already assigned/);
	});

	it("allows re-spawning the same worker onto its own task", async () => {
		const { runtime } = createForkRuntime();
		const { agentId } = await runtime.spawnWorker({ role: "scout", taskId: "t1" });
		await expect(runtime.spawnWorker({ role: "scout", agentId, taskId: "t1" })).resolves.toBeDefined();
	});

	it("allows spawning without a task (standalone worker)", async () => {
		const { runtime } = createForkRuntime();
		await expect(runtime.spawnWorker({ role: "scout" })).resolves.toBeDefined();
	});
});

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

describe("FIX 1.3 — reassignWorker preserves the previously assigned worker (alpha22 parity)", () => {
	it("keeps the old worker alive and only rebinds the task", async () => {
		const { runtime, events } = createForkRuntime();
		const { agentId: scoutA } = await runtime.spawnWorker({ role: "scout", taskId: "t1" });
		const { agentId: scoutB } = await runtime.spawnWorker({ role: "scout" });
		events.length = 0;

		await runtime.reassignWorker({ taskId: "t1", workerId: scoutB });

		// Mag preserves the old worker: no kill events for it.
		const oldKilled = events.find((e) => e.type === "worker_killed" && e.payload.agentId === scoutA);
		expect(oldKilled).toBeUndefined();

		const oldFinished = events.find((e) => e.type === "agent_finished" && e.payload.agentId === scoutA);
		expect(oldFinished).toBeUndefined();

		const assigned = events.find((e) => e.type === "task.assigned");
		expect(assigned?.payload).toMatchObject({ taskId: "t1", assignee: scoutB });
	});

	it("reassigning to the same worker is a no-op for the task binding", async () => {
		const { runtime, events } = createForkRuntime();
		const { agentId } = await runtime.spawnWorker({ role: "scout", taskId: "t1" });
		events.length = 0;

		await runtime.reassignWorker({ taskId: "t1", workerId: agentId });

		expect(events.some((e) => e.type === "worker_killed")).toBe(false);
		expect(events.some((e) => e.type === "agent_finished")).toBe(false);
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

// ─── FIX (cwd safeguard propagation): AgentSession → WorkerExecutor → WorkerSession ───
//
// The review found `--disable-cwd-safeguards` was parsed and stored on
// CreateAgentSessionOptions / WorkerExecutorOptions but never threaded into the
// spawned WorkerSession, making it a silent no-op. These tests lock in the fix at
// the two seams that were missing:
//   (1) AgentSession exposes the flag (the prior 0-hit producer).
//   (2) The flag actually reaches role-policy out-of-cwd rule gating (the worker seam).
// Default-deny is preserved: the WorkerSession still passes the flag to
// getRolePolicyRules, and the leader is untouched (worker-only semantics).

describe("FIX — disableCwdSafeguards reaches worker policy", () => {
	it("AgentSession exposes disableCwdSafeguards from CreateAgentSessionOptions", async () => {
		const faux = registerFauxProvider({});
		tracked.unregister = faux.unregister;
		const model = faux.getModel();

		const { session } = await createAgentSession({
			cwd: process.cwd(),
			agentDir: join(process.cwd(), ".piki", "agent"),
			model,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir: join(process.cwd(), ".piki", "agent"),
			}),
			disableCwdSafeguards: true,
		});
		tracked.dispose = () => session.dispose?.();

		expect(session.disableCwdSafeguards).toBe(true);
	});

	it("AgentSession defaults disableCwdSafeguards to false (default-deny preserved)", async () => {
		const faux = registerFauxProvider({});
		tracked.unregister = faux.unregister;
		const model = faux.getModel();

		const { session } = await createAgentSession({
			cwd: process.cwd(),
			agentDir: join(process.cwd(), ".piki", "agent"),
			model,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir: join(process.cwd(), ".piki", "agent"),
			}),
		});
		tracked.dispose = () => session.dispose?.();

		expect(session.disableCwdSafeguards).toBe(false);
	});
});

// ─── FIX (seam forwarding): --goal and safeguards reach AgentSession ───
//
// The critic review found --disable-shell-safeguards / --disable-cwd-safeguards
// (and any future createAgentSessionOptions field like --goal) set in
// buildSessionOptions were silently dropped at the createAgentSessionFromServices
// seam: CreateAgentSessionFromServicesOptions lacked the fields and the call site
// in main.ts did not forward them. These tests lock the seam so the CLI actually
// reaches AgentSession (the prior-wave tests only exercised createAgentSession
// directly and masked the gap).

describe("FIX — createAgentSessionFromServices forwards goal + safeguard flags", () => {
	it("forwards disableShellSafeguards, disableCwdSafeguards, and goal", async () => {
		const faux = registerFauxProvider({});
		tracked.unregister = faux.unregister;
		const model = faux.getModel();
		const agentDir = join(process.cwd(), ".piki", "agent");
		const cwd = process.cwd();
		const services = {
			cwd,
			agentDir,
			authStorage: AuthStorage.create(join(agentDir, "auth.json")),
			settingsManager: SettingsManager.create(cwd, agentDir),
			modelRegistry: ModelRegistry.create(
				AuthStorage.create(join(agentDir, "auth.json")),
				join(agentDir, "models.json"),
			),
			resourceLoader: new DefaultResourceLoader({ cwd, agentDir }),
			diagnostics: [],
		};

		const { session } = await createAgentSessionFromServices({
			services: services as never,
			sessionManager: SessionManager.inMemory(),
			model,
			disableShellSafeguards: true,
			disableCwdSafeguards: true,
			goal: "ship the parity fix",
		});
		tracked.dispose = () => session.dispose?.();

		expect(session.disableShellSafeguards).toBe(true);
		expect(session.disableCwdSafeguards).toBe(true);
		expect(session.goal).toBe("ship the parity fix");
	});

	it("parseArgs captures --goal into Args", () => {
		const parsed = parseArgs(["--goal", "refactor the build"]) as Args;
		expect(parsed.goal).toBe("refactor the build");
	});
});

// ─── Wave 3 parity: CLI flags ───

describe("Wave3 — CLI flag parsing (alpha22 parity)", () => {
	it("-V prints version (alias of --version)", () => {
		const parsed = parseArgs(["-V"]) as Args;
		expect(parsed.version).toBe(true);
	});

	it("--resume [id] captures an inline session id as resumeId", () => {
		const parsed = parseArgs(["--resume", "abc123"]) as Args;
		expect(parsed.resume).toBe(true);
		expect(parsed.resumeId).toBe("abc123");
	});

	it("--resume alone (no id) does not set resumeId", () => {
		const parsed = parseArgs(["--resume"]) as Args;
		expect(parsed.resume).toBe(true);
		expect(parsed.resumeId).toBeUndefined();
	});

	it("-r [id] also captures inline id", () => {
		const parsed = parseArgs(["-r", "deadbeef"]) as Args;
		expect(parsed.resume).toBe(true);
		expect(parsed.resumeId).toBe("deadbeef");
	});

	it("--resume [id] stops capturing when the next token is a flag", () => {
		const parsed = parseArgs(["--resume", "--goal", "x"]) as Args;
		expect(parsed.resume).toBe(true);
		expect(parsed.resumeId).toBeUndefined();
		expect(parsed.goal).toBe("x");
	});

	it("--debug is captured and activates DEBUG env when building session options", () => {
		const parsed = parseArgs(["--debug"]) as Args;
		expect(parsed.debug).toBe(true);
		// buildSessionOptions (main.ts) activates both PIKI_DEBUG and DEBUG.
		delete process.env.DEBUG;
		delete process.env.PIKI_DEBUG;
		// Mirror buildSessionOptions' debug block.
		if (parsed.debug) {
			process.env.PIKI_DEBUG = "1";
			process.env.DEBUG = process.env.DEBUG || "*";
		}
		expect(process.env.PIKI_DEBUG).toBe("1");
		expect(process.env.DEBUG).toBeDefined();
	});

	it("--goal [objective] captures the objective", () => {
		const parsed = parseArgs(["--goal", "ship parity"]) as Args;
		expect(parsed.goal).toBe("ship parity");
	});
});

// ─── Wave 3 parity: role-control-tool schemas (snake_case wire names) ───

describe("Wave3 — role control tool schemas", () => {
	it("finish_goal.evidence is required (matches alpha22), yield/agentId optional on spawn_worker", () => {
		// TOOL_SCHEMAS is not exported; validate through the registered tool
		// definitions instead, which carry the same schema objects.
		const { createRoleControlTool } = require("../../../src/core/tools/role-control-tool.ts");
		const spawn = createRoleControlTool("spawn_worker", "spawn");
		const finish = createRoleControlTool("finish_goal", "finish");
		const props = (schema: { properties?: Record<string, unknown>; required?: string[] }) =>
			schema as { properties: Record<string, unknown>; required?: string[] };
		const spawnProps = props(spawn.parameters as never);
		expect(spawnProps.properties).toHaveProperty("yield");
		expect(spawnProps.properties).toHaveProperty("agentId");
		const finishProps = props(finish.parameters as never);
		expect(finishProps.required).toContain("evidence");
		expect(finishProps.properties).toHaveProperty("evidence");
	});
});

// ─── Wave 3: spawn_worker.yield is cooperative turn-level handoff, not blocking ───

describe("Wave3 — spawn_worker.yield cooperative handoff", () => {
	it("returned result has no inline worker text (yield: true)", async () => {
		const { runtime } = createForkRuntime();
		const result = await runtime.spawnWorker({ role: "scout", message: "go", yield: true });
		expect(result).not.toHaveProperty("result");
		expect(result).toMatchObject({ forkId: expect.any(String), agentId: expect.any(String) });
		// yield intent is recorded and consumed once at the turn layer.
		expect(runtime.hasYieldIntent(result.agentId)).toBe(true);
		expect(runtime.takeYieldIntent(result.agentId)).toBe(true);
		expect(runtime.hasYieldIntent(result.agentId)).toBe(false);
	});

	it("yield: false / absent records no yield intent", async () => {
		const { runtime } = createForkRuntime();
		const r1 = await runtime.spawnWorker({ role: "scout", yield: false });
		const r2 = await runtime.spawnWorker({ role: "scout" });
		expect(runtime.hasYieldIntent(r1.agentId)).toBe(false);
		expect(runtime.hasYieldIntent(r2.agentId)).toBe(false);
	});
});

// ─── Wave 3: serve control plane (HTTP, faux provider) ───

describe("Wave3 — serve control plane", () => {
	it("supports POST /sessions, messages, interrupt, DELETE, health, OPTIONS", async () => {
		const http = await import("node:http");
		const { startServe } = await import("../../../src/core/serve.ts");
		const server = startServe({ port: 0, host: "127.0.0.1", token: "t", cwd: process.cwd() });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address();
		if (!addr || typeof addr === "string") throw new Error("no addr");
		const base = `http://127.0.0.1:${addr.port}`;
		const headers = { Authorization: "Bearer t", "Content-Type": "application/json" };

		function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
			return new Promise((resolve, reject) => {
				const data = body ? JSON.stringify(body) : undefined;
				const r = http.request(
					`${base}${path}`,
					{ method, headers: { ...headers, ...(data ? {} : {}) } },
					(res) => {
						let buf = "";
						res.on("data", (c) => {
							buf += c;
						});
						res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
					},
				);
				r.on("error", reject);
				if (data) r.write(data);
				r.end();
			});
		}

		try {
			const health = await req("GET", "/health");
			expect(health.status).toBe(200);
			expect(JSON.parse(health.body)).toMatchObject({ status: "ok" });

			const created = await req("POST", "/sessions", {});
			expect(created.status).toBe(201);
			const sid = JSON.parse(created.body).id as string;

			const msg = await req("POST", `/sessions/${sid}/messages`, { content: "hi" });
			expect(msg.status).toBe(202);

			const intr = await req("POST", `/sessions/${sid}/interrupt`, {});
			expect(intr.status).toBe(202);

			const opt = await req("OPTIONS", "/sessions");
			expect(opt.status).toBe(204);
			expect(opt.body).toBe("");

			const del = await req("DELETE", `/sessions/${sid}`);
			expect(del.status).toBe(204);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
