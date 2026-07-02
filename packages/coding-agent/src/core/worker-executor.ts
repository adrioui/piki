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

import type { Model } from "@earendil-works/pi-ai";
import type { EventEnvelope, ForkedProjectionStore, RoleDefinition } from "@earendil-works/pi-event-core";
import { DetachedProcessRegistry } from "./detached-process-registry.ts";
import type { PermissionRule } from "./permissions/permission-gate.ts";
import { buildWorkerContext } from "./worker-context-builder.ts";
import { WorkerEffectRuntime } from "./worker-effect-runtime.ts";
import { WorkerSession, type WorkerTool } from "./worker-session.ts";
import { filterToolsForRole } from "./worker-tools.ts";

type RuntimeEvent = EventEnvelope<string, Record<string, unknown>>;

export interface WorkerExecutorOptions {
	resolveModel: (role: string) => Model<string> | undefined;
	getSystemPrompt: (role: string) => string;
	getAllTools: () => WorkerTool[];
	getProjectContext: () => string;
	getTranscript: () => string;
	publishEvent: (type: string, payload: Record<string, unknown>) => Promise<void>;
	userRules?: PermissionRule[];
	forkedProjectionStore?: ForkedProjectionStore<RuntimeEvent>;
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
	private readonly options: WorkerExecutorOptions;
	private currentForkId: string | undefined;

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
			context?: string;
			message?: string;
			mode?: string;
		};

		const { forkId, agentId, role } = payload;
		if (payload.mode !== "spawn" || role === "leader") return;

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
			systemPrompt = this.options.getSystemPrompt(role);
			const allTools = this.options.getAllTools();
			filteredTools = filterToolsForRole(role, allTools);
			const projectContext = this.options.getProjectContext();
			context = buildWorkerContext({
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

		const session = new WorkerSession({
			forkId,
			agentId,
			role,
			model,
			systemPrompt: `${systemPrompt}\n\n${context}`,
			initialMessage: payload.message ?? payload.context ?? "",
			tools: filteredTools,
			contextLimit: model.contextWindow ?? 128000,
			userRules: this.options.userRules ?? [],
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
		});

		this.workers.set(agentId, session);
		let forkSet = this.forkWorkers.get(forkId);
		if (!forkSet) {
			forkSet = new Set();
			this.forkWorkers.set(forkId, forkSet);
		}
		forkSet.add(agentId);
		await this.runtime.drainMessages(agentId, (message) => session.deliverMessage(message));

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
	}

	private async onWorkerMessaged(event: RuntimeEvent): Promise<void> {
		const payload = event.payload as { workerId: string; message: string };
		const session = this.workers.get(payload.workerId);
		if (session) {
			session.deliverMessage(payload.message);
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
