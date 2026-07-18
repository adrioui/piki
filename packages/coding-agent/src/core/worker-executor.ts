/**
 * WorkerExecutor — connects ForkRuntime.spawnWorker() (which publishes agent_created)
 * to an actual LLM agent loop.
 *
 * Registered as a role on the event sink. Reacts to:
 * - agent_created: spawns a WorkerSession
 * - worker_messaged: delivers a message to the worker
 * - agent_finished (killed): kills and cleans up the worker
 *
 * Uses concurrencyKey per fork to prevent races.
 */

import type { AgentToolResult, StreamFn, ThinkingLevel } from "@piki/agent-core";
import type { CacheRetention, Model } from "@piki/ai";
import {
	type EventEnvelope,
	type ForkedProjectionStore,
	ROLE_DEFINITIONS,
	type RoleDefinition,
} from "@piki/event-core";
import { renderWorkerSystemPrompt } from "@piki/roles";
import { formatSkillsForPrompt } from "@piki/skills";
import { Effect } from "effect";
import { DetachedProcessRegistry } from "./detached-process-registry.ts";
import { getThinkingLevelForTier } from "./model-tier-config.ts";
import { createObserverToolkit } from "./observer/toolkit.ts";
import type { PermissionRule } from "./permissions/permission-gate.ts";
import type { SessionEntry } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { buildRoleAwareWorkerContext, buildWorkerContext } from "./worker-context-builder.ts";
import { WorkerEffectRuntime } from "./worker-effect-runtime.ts";
import { WorkerLifecycleRegistry } from "./worker-lifecycle-registry.ts";
import { WorkerSession, type WorkerTool } from "./worker-session.ts";
import { filterToolsForRole } from "./worker-tools.ts";

type RuntimeEvent = EventEnvelope<string, Record<string, unknown>>;

export interface WorkerExecutorOptions {
	resolveModel: (role: string) => Model<string> | undefined;
	/**
	 * Stream function used by spawned workers to call their model. Mirrors the
	 * leader's Agent.streamFn (built in sdk.ts) so workers resolve API keys,
	 * headers, env, and retry settings the same way. Without this, workers fall
	 * back to the bare streamSimple, which has no API key and throws
	 * `No API key for provider: <provider>` for any key-based provider.
	 */
	streamFn?: StreamFn;
	getAllTools: () => WorkerTool[];
	/** Optional: returns all loaded skills for role-based filtering. */
	getAllSkills?: () => import("@piki/skills").Skill[];
	getProjectContext: () => string;
	cwd?: string;
	scratchpadPath?: string;
	getTranscript: () => string;
	getScratchpad?: () => string;
	getProcessContext?: () => string;
	/** Per-tool execution timeout resolver shared from the leader's SettingsManager. */
	getToolTimeoutMs?: (toolName: string) => number | undefined;
	/** Default thinking level for spawned workers, derived from the leader's SettingsManager. */
	getDefaultThinkingLevel?: () => ThinkingLevel | undefined;
	/** Worker maxTurns resolver shared from the leader's SettingsManager. */
	getWorkerMaxTurns?: () => number;
	/** Prompt-cache retention applied to all spawned workers. */
	cacheRetention?: CacheRetention;
	publishEvent: (type: string, payload: Record<string, unknown>) => Promise<void>;
	/** Shared SettingsManager so spawned workers inherit declarative permissionRules. */
	settingsManager?: SettingsManager;
	userRules?: PermissionRule[];
	forkedProjectionStore?: ForkedProjectionStore<RuntimeEvent>;
	/** Shared ref to the leader's ExtensionRunner so spawned workers fire extension tool hooks. */
	extensionRunnerRef?: { current?: import("./extensions/index.ts").ExtensionRunner };
	/** When true, forbid/mass-destructive shell classification and destructive rules are allowed. */
	disableShellSafeguards?: boolean;
	/** When true, role-policy out-of-cwd write rules are skipped (worker-only). */
	disableCwdSafeguards?: boolean;
	onWorkerFinished: (result: {
		text: string;
		forkId: string;
		agentId: string;
		role: string;
		stopReason?: string;
	}) => void;
	onWorkerError: (error: { error: string; forkId: string; agentId: string; role: string }) => void;
}

/**
 * Global registry for the currently active WorkerExecutor instance.
 * Allows detached process tracking to register PIDs with the correct fork.
 */
let activeWorkerExecutor: WorkerExecutor | undefined;

/**
 * Set the fork context for detached process tracking.
 * Called when a worker tool starts executing in a fork context.
 */
export function setForkContext(forkId: string | undefined): void {
	activeWorkerExecutor?._setCurrentFork(forkId);
}

export class WorkerExecutor {
	private readonly workers = new Map<string, WorkerSession>();
	private readonly forkWorkers = new Map<string, Set<string>>();
	private readonly intentionallyKilled = new Set<string>();
	private readonly finalizedWorkers = new Set<string>();
	private readonly detachedRegistry = new DetachedProcessRegistry();
	private readonly runtime = new WorkerEffectRuntime();
	private readonly lifecycle = new WorkerLifecycleRegistry();
	private readonly options: WorkerExecutorOptions;
	private currentForkId: string | undefined;
	/** Per-fork captured worker SessionEntry buffers (for ATIF subagent_trajectories). Retained for the whole session; cleared only in dispose(). */
	private readonly forkEntries = new Map<string, SessionEntry[]>();
	/** Per-fork real fork metadata captured from the `agent_created` event (for ATIF spawn-step real `agentId`/`role`/`taskId`/`mode`/`message`). */
	private readonly forkMeta = new Map<
		string,
		{
			agentId: string;
			parentForkId: string | null;
			role: string;
			taskId: string | undefined;
			mode: string;
			message: string | undefined;
		}
	>();

	/** Register a detached process PID for the current fork. */
	registerDetachedPid(pid: number, outputPath?: string): void {
		if (this.currentForkId) {
			this.detachedRegistry.register(pid, this.currentForkId, { outputPath });
		}
	}

	/** Unregister a detached process PID. */
	unregisterDetachedPid(pid: number): void {
		this.detachedRegistry.unregister(pid);
	}

	/** Get the DetachedProcessRegistry for external use. */
	getDetachedProcessRegistry(): DetachedProcessRegistry {
		return this.detachedRegistry;
	}

	/** Record a worker-session entry into the per-fork buffer. */
	recordForkEntry(forkId: string, entry: SessionEntry): void {
		let arr = this.forkEntries.get(forkId);
		if (!arr) {
			arr = [];
			this.forkEntries.set(forkId, arr);
		}
		arr.push(entry);
	}

	/** Read-only view of the captured per-fork worker entries. */
	getForkEntries(): Map<string, SessionEntry[]> {
		return this.forkEntries;
	}

	/** Read-only view of the captured per-fork real fork metadata (agentId/role/taskId/mode/message). */
	getForkMeta(): Map<
		string,
		{
			agentId: string;
			parentForkId: string | null;
			role: string;
			taskId: string | undefined;
			mode: string;
			message: string | undefined;
		}
	> {
		return this.forkMeta;
	}

	getWorkerLifecycleRegistry(): WorkerLifecycleRegistry {
		return this.lifecycle;
	}

	/** Set the current fork context for detached process registration. */
	_setCurrentFork(forkId: string | undefined): void {
		this.currentForkId = forkId;
	}

	constructor(options: WorkerExecutorOptions) {
		this.options = options;
		activeWorkerExecutor = this;
	}

	asRole(): RoleDefinition<RuntimeEvent> {
		return {
			name: "WorkerExecutor",
			match: (event) =>
				event.type === "agent_created" ||
				event.type === "worker_messaged" ||
				(event.type === "agent_finished" && Boolean(event.payload.killed)),
			concurrencyKey: (event) =>
				event.type === "worker_messaged"
					? String(event.payload.workerId ?? event.id)
					: String(event.payload.forkId ?? event.payload.agentId ?? event.id),
			run: async (ctx) => {
				if (ctx.event.type === "agent_created") {
					await this.onAgentCreated(ctx.event);
				} else if (ctx.event.type === "worker_messaged") {
					await this.onWorkerMessaged(ctx.event);
				} else if (ctx.event.type === "agent_finished" && ctx.event.payload.killed) {
					await this.onWorkerKilled(ctx.event);
				}
			},
		};
	}

	private async onAgentCreated(event: RuntimeEvent): Promise<void> {
		const payload = event.payload as {
			forkId: string;
			agentId: string;
			role: string;
			parentForkId?: string | null;
			context?: string;
			message?: string;
			mode?: string;
			taskId?: string;
		};

		const { forkId, agentId, role } = payload;
		if (payload.mode !== "spawn" || role === "leader") return;
		this.forkMeta.set(forkId, {
			agentId,
			parentForkId: payload.parentForkId ?? null,
			role,
			taskId: payload.taskId,
			mode: payload.mode ?? "spawn",
			message: payload.message,
		});
		await Effect.runPromise(this.lifecycle.apply({ type: "created", forkId, agentId, role }));

		const model = this.options.resolveModel(role);
		if (!model) {
			await this.publishTerminalSpawnFailure(forkId, agentId, role, "no_model");
			this.options.onWorkerError({ error: `No model resolved for role: ${role}`, forkId, agentId, role });
			return;
		}

		let systemPrompt: string;
		let filteredTools: WorkerTool[];
		let context: string;
		try {
			systemPrompt = renderWorkerSystemPrompt(role, {
				skills: formatSkillsForPrompt(this.options.getAllSkills?.() ?? [], { role }),
				cwd: this.options.cwd ?? process.cwd(),
				// Per-role thinking limit so workers inherit the role's maxThoughtChars
				// (e.g. scout=2000) instead of the default 20000. Matches mag's
				// per-role thinking governance injection.
				thinkingLimit: ROLE_DEFINITIONS[role]?.maxThoughtChars ?? 20000,
			});
			if (role === "observer") {
				// The observer is a tool-calling agent: it decides pass/escalate via
				// the observerToolkit (pass/escalate tools) instead of an aux-model
				// JSON boolean call. Each tool returns a verdict that we re-publish
				// as an `observer_verdict` runtime event so the orchestrator can act
				// on it (inject pass / trigger advisor consultation).
				filteredTools = createObserverToolkit().map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					execute: async (id, args): Promise<AgentToolResult<unknown>> => {
						const result = await tool.execute(id, args);
						try {
							const verdict = JSON.parse((result.content[0]?.text ?? "{}") as string) as Record<string, unknown>;
							await this.options.publishEvent("observer_verdict", { ...verdict, role: "observer" });
						} catch {
							// Ignore malformed verdict; the observer will simply not escalate.
						}
						return { content: result.content, details: null };
					},
				}));
			} else {
				const allTools = this.options.getAllTools();
				filteredTools = filterToolsForRole(role, allTools);
			}

			// Build role-aware context using the role's context lens
			const roleDef = ROLE_DEFINITIONS[role];
			const projectContext = this.options.getProjectContext();
			context = roleDef
				? buildRoleAwareWorkerContext({
						roleDef,
						sessionStart: "",
						projectContext,
						transcript: this.options.getTranscript(),
						scratchpad: this.options.getScratchpad?.(),
						processContext: this.options.getProcessContext?.(),
					})
				: buildWorkerContext({
						sessionStart: "",
						projectContext,
						transcript: this.options.getTranscript(),
					});
		} catch (err) {
			await this.publishTerminalSpawnFailure(forkId, agentId, role, "spawn_setup_error");
			this.options.onWorkerError({
				error: `Worker setup failed: ${err instanceof Error ? err.message : String(err)}`,
				forkId,
				agentId,
				role,
			});
			return;
		}

		const roleTier = ROLE_DEFINITIONS[role]?.tier;
		const leaderThinkingLevel = this.options.getDefaultThinkingLevel?.();
		const thinkingLevel = getThinkingLevelForTier(roleTier, leaderThinkingLevel ?? "off");

		const session = new WorkerSession({
			forkId,
			agentId,
			role,
			model,
			thinkingLevel,
			systemPrompt,
			getProjectContext: () => {
				if (!this.options.getProjectContext) return context;
				try {
					return this.options.getProjectContext();
				} catch {
					return context;
				}
			},
			initialMessage: payload.message ?? payload.context ?? "",
			tools: filteredTools,
			maxTurns: role === "observer" ? 1 : this.options.getWorkerMaxTurns?.(),
			contextLimit: model.contextWindow ?? 128000,
			cwd: this.options.cwd,
			scratchpadPath: this.options.scratchpadPath,
			streamFn: this.options.streamFn,
			cacheRetention: this.options.cacheRetention,
			userRules: [...(this.options.settingsManager?.getPermissionRules() ?? []), ...(this.options.userRules ?? [])],
			disableShellSafeguards: this.options.disableShellSafeguards,
			disableCwdSafeguards: this.options.disableCwdSafeguards,
			extensionRunnerRef: this.options.extensionRunnerRef,
			getToolTimeoutMs: this.options.getToolTimeoutMs,
			publishEvent: (type, eventPayload) =>
				this.options.publishEvent(type, {
					...eventPayload,
					forkId,
					agentId,
					role,
				}),
			onFinished: (result) => {
				const killed = this.isKilled(agentId);
				void this.finalizeWorker(forkId, agentId, killed ? "killed" : "finished");
				if (killed) return;
				this.options.onWorkerFinished({ ...result, role });
			},
			onError: (error) => {
				const killed = this.isKilled(agentId);
				void this.finalizeWorker(forkId, agentId, killed ? "killed" : "error");
				if (killed) return;
				this.options.onWorkerError({ ...error, role });
			},
			onForkEntry: (entry) => this.recordForkEntry(forkId, entry),
		});

		this.workers.set(agentId, session);
		let forkSet = this.forkWorkers.get(forkId);
		if (!forkSet) {
			forkSet = new Set();
			this.forkWorkers.set(forkId, forkSet);
		}
		forkSet.add(agentId);

		// Start the worker session FIRST so it can begin consuming its queue and
		// run turns. `startSession` forks a fiber and returns immediately.
		this.runtime.startSession(agentId, session, (err) => {
			const killed = this.isKilled(agentId);
			void this.finalizeWorker(forkId, agentId, killed ? "killed" : "error");
			if (killed) return;
			this.options.onWorkerError({
				error: `Worker session crashed: ${err instanceof Error ? err.message : String(err)}`,
				forkId,
				agentId,
				role,
			});
		});
		await Effect.runPromise(this.lifecycle.apply({ type: "started", agentId }));

		// Drain any pre-start messages that queued up before the session began.
		// Fire-and-forget (void): `drainMessages` blocks on Queue.take until the
		// queue is shut down in removeWorker, so awaiting it here would hang the
		// spawn forever. `deliverMessage` → `maybeRetrigger` re-entry handles
		// messages that arrive after the queue is drained.
		void this.runtime.drainMessages(agentId, (message) => session.deliverMessage(message));
	}

	private async onWorkerMessaged(event: RuntimeEvent): Promise<void> {
		const payload = event.payload as { workerId: string; message: string };
		const session = this.workers.get(payload.workerId);
		if (session) {
			session.deliverMessage(payload.message);
			await Effect.runPromise(this.lifecycle.apply({ type: "messaged", agentId: payload.workerId }));
			return;
		}
		await this.runtime.offerMessage(payload.workerId, payload.message);
	}

	private async onWorkerKilled(event: RuntimeEvent): Promise<void> {
		const payload = event.payload as { agentId: string; forkId: string };
		const session = this.workers.get(payload.agentId);
		if (!session) {
			return;
		}
		this.intentionallyKilled.add(payload.agentId);
		await Effect.runPromise(
			this.lifecycle.apply({
				type: "finished",
				agentId: payload.agentId,
				status: "killed",
				reason: "killed",
			}),
		);
		await this.runtime.killSession(payload.agentId, session);
		this.detachedRegistry.killAll(payload.forkId);
	}

	private isKilled(agentId: string): boolean {
		return this.intentionallyKilled.has(agentId);
	}

	private async finalizeWorker(
		forkId: string,
		agentId: string,
		reason: "finished" | "error" | "killed",
	): Promise<void> {
		if (this.finalizedWorkers.has(agentId)) return;
		this.finalizedWorkers.add(agentId);
		this.intentionallyKilled.delete(agentId);
		await Effect.runPromise(this.lifecycle.apply({ type: "finished", agentId, status: reason, reason }));
		await this.options.publishEvent("fork_cleaned", {
			forkId,
			agentId,
			reason,
		});
		this.cleanupWorker(forkId, agentId);
	}

	private cleanupWorker(forkId: string, agentId: string): void {
		this.workers.delete(agentId);
		void this.runtime.removeWorker(agentId);
		const forkSet = this.forkWorkers.get(forkId);
		if (forkSet) {
			forkSet.delete(agentId);
			if (forkSet.size === 0) this.forkWorkers.delete(forkId);
		}
		this.options.forkedProjectionStore?.removeFork(forkId);
		void Effect.runPromise(this.lifecycle.apply({ type: "cleaned", agentId, reason: "cleanup" }));
	}

	isWorkerRunning(agentId: string): boolean {
		return this.workers.has(agentId);
	}

	private async publishTerminalSpawnFailure(
		forkId: string,
		agentId: string,
		role: string,
		reason: string,
	): Promise<void> {
		await this.options.publishEvent("agent_finished", {
			agentId,
			forkId,
			role,
			killed: true,
			stopReason: "error",
			reason,
			willRetry: false,
		});
		void this.options.publishEvent("fork_cleaned", { forkId, agentId, reason: "error" });
		void this.runtime.removeWorker(agentId);
	}

	dispose(): void {
		this.runtime.dispose(this.workers.values());
		this.workers.clear();
		this.intentionallyKilled.clear();
		this.finalizedWorkers.clear();
		this.detachedRegistry.dispose();
		this.forkWorkers.clear();
		this.forkEntries.clear();
		this.forkMeta.clear();
		if (activeWorkerExecutor === this) {
			activeWorkerExecutor = undefined;
		}
	}
}

/**
 * Register a detached process PID with the active worker executor (if any).
 * Called from trackDetachedChildPid to enable per-fork process killing.
 */
export function registerDetachedProcessWithExecutor(pid: number, outputPath?: string): void {
	activeWorkerExecutor?.registerDetachedPid(pid, outputPath);
}

/**
 * Unregister a detached process PID from the active worker executor (if any).
 */
export function unregisterDetachedProcessFromExecutor(pid: number): void {
	activeWorkerExecutor?.unregisterDetachedPid(pid);
}
