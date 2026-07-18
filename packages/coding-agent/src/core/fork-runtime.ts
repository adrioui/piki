/**
 * Fork-Worker Runtime Adapter - Phase 0.
 *
 * Runtime adapter that publishes agent_created, agent_finished, task, and goal
 * events via the SessionOrchestrator's publishRuntimeEvent.
 *
 * Each role tool call publishes the appropriate event-core event, which
 * projections and roles react to. Role model selection uses AgentModelResolver
 * for tier-based routing.
 */

import { randomUUID } from "node:crypto";
import { SPAWNABLE_ROLES } from "@piki/event-core";
import { Effect, STM, TSemaphore } from "effect";

export type PublishFn = (type: string, payload: Record<string, unknown>) => Promise<void>;

export interface ForkRuntimeOptions {
	/** The session ID (used as the parent fork ID). */
	sessionId: string;
	/** The publish function from SessionOrchestrator. */
	publish: PublishFn;
	/** Current session sequence (for event ordering). */
	getSequence: () => number;
	/** Optional model resolver for role-based model selection when spawning workers. */
	resolveModel?: (role: string) => { provider: string; id: string } | undefined;
}

export interface SpawnWorkerInput {
	role: string;
	message?: string;
	taskId?: string;
	context?: string;
	agentId?: string;
	/**
	 * When true, block the caller (leader) until the spawned worker produces
	 * its first result, mirroring Magnitude alpha22's `spawn_worker({yield:true})`
	 * synchronous-handoff semantics.
	 */
	yield?: boolean;
}

export interface MessageWorkerInput {
	workerId: string;
	message: string;
	/**
	 * When true, register a cooperative yield intent for the leader turn so
	 * control passes to the workers (alpha22 `yieldTarget = "workers"`).
	 */
	yield?: boolean;
}

export interface KillWorkerInput {
	workerId: string;
	reason?: string;
}

export interface CreateTaskInput {
	/** Caller-provided task ID; used verbatim if provided, else randomUUID. */
	taskId?: string;
	title: string;
	description?: string;
	parentId?: string;
	/** Task ID this task depends on (runs after). */
	after?: string;
	assignee?: string;
}

export interface UpdateTaskInput {
	taskId: string;
	status: "pending" | "completed" | "cancelled";
}

export interface FinishGoalInput {
	evidence?: string;
}

export interface PassInput {
	message?: string;
}

export interface EscalateInput {
	justification: string;
	message?: string;
}

export interface ReassignWorkerInput {
	taskId: string;
	workerId: string;
}

export interface MessageAdvisorInput {
	message: string;
}

/**
 * Fork-worker runtime adapter.
 *
 * Each method corresponds to one of the 10 role tools and publishes
 * the appropriate event-core event via the orchestrator's publish function.
 */
export class ForkRuntime {
	private readonly sessionId: string;
	private readonly publish: PublishFn;
	private readonly getSequence: () => number;
	private readonly resolveModel?: (role: string) => { provider: string; id: string } | undefined;
	private readonly workerForkIds = new Map<string, string>();
	/** taskId → agentId currently assigned, used by reassign and spawn validation. */
	private readonly taskAssignees = new Map<string, string>();
	/** agentId → true when the spawn requested `yield: true`. Consumed at the
	 * turn layer (not inline) to implement Magnitude alpha22's cooperative
	 * `yieldTarget = "workers"` handoff. */
	private readonly yieldIntents = new Set<string>();
	private readonly mutationSemaphore = Effect.runSync(STM.commit(TSemaphore.make(1)));

	constructor(options: ForkRuntimeOptions) {
		this.sessionId = options.sessionId;
		this.publish = options.publish;
		this.getSequence = options.getSequence;
		this.resolveModel = options.resolveModel;
	}

	private withMutation<T>(run: () => Promise<T>): Promise<T> {
		return Effect.runPromise(TSemaphore.withPermit(this.mutationSemaphore)(Effect.tryPromise(run)));
	}

	/**
	 * Spawn a worker agent. Publishes an `agent_created` event.
	 * The role must be spawnable (in SPAWNABLE_ROLES).
	 */
	async spawnWorker(input: SpawnWorkerInput): Promise<{ forkId: string; agentId: string }> {
		if (!SPAWNABLE_ROLES.has(input.role)) {
			throw new Error(`Role "${input.role}" is not spawnable. Spawnable roles: ${[...SPAWNABLE_ROLES].join(", ")}`);
		}
		// Alpha22 contract: a worker can only be bound to a task that is not
		// already owned by a different worker. This prevents two workers from
		// being silently attached to the same task.
		const agentId = input.agentId && String(input.agentId).length > 0 ? String(input.agentId) : randomUUID();
		if (input.taskId) {
			const existing = this.taskAssignees.get(input.taskId);
			if (existing && existing !== agentId) {
				throw new Error(
					`Task "${input.taskId}" is already assigned to worker "${existing}"; cannot assign to "${agentId}"`,
				);
			}
		}
		return this.withMutation(async () => {
			const forkId = randomUUID();
			const model = this.resolveModel?.(input.role);
			await this.publish("agent_created", {
				forkId,
				parentForkId: this.sessionId,
				agentId,
				name: input.role,
				role: input.role,
				context: input.context ?? input.message ?? "",
				mode: "spawn",
				taskId: input.taskId,
				message: input.message,
				model: model ? { provider: model.provider, id: model.id } : undefined,
			});
			this.workerForkIds.set(agentId, forkId);
			if (input.taskId) {
				this.taskAssignees.set(input.taskId, agentId);
			}
			if (input.yield) {
				// Cooperative turn-level handoff (alpha22 `yieldTarget = "workers"`).
				// The leader turn ends after spawning; control passes to the workers.
				// The worker result is delivered via the worker_finished/worker_result
				// path, not returned inline to the tool caller.
				this.yieldIntents.add(agentId);
			}
			await this.publish("fork_created", {
				forkId,
				parentForkId: this.sessionId,
				agentId,
				role: input.role,
			});
			return { forkId, agentId };
		});
	}

	/**
	 * True if the spawn that produced `agentId` requested `yield: true`.
	 * Consumed once (turn-level) by the orchestrator to set the leader turn's
	 * cooperative handoff target.
	 */
	hasYieldIntent(agentId: string): boolean {
		return this.yieldIntents.has(agentId);
	}

	/**
	 * Take and clear the yield intent for `agentId` (turn-level, one-shot).
	 */
	takeYieldIntent(agentId: string): boolean {
		if (this.yieldIntents.has(agentId)) {
			this.yieldIntents.delete(agentId);
			return true;
		}
		return false;
	}

	/**
	 * Send a message to a worker. Publishes a `worker_messaged` event.
	 */
	async messageWorker(input: MessageWorkerInput): Promise<void> {
		if (input.yield) {
			// Cooperative turn-level handoff (alpha22 `yieldTarget = "workers"`).
			this.yieldIntents.add(input.workerId);
		}
		await this.publish("worker_messaged", {
			workerId: input.workerId,
			forkId: this.workerForkIds.get(input.workerId),
			message: input.message,
			sessionId: this.sessionId,
		});
	}

	/**
	 * Kill a worker. Publishes an `agent_finished` event with killed status.
	 */
	async killWorker(input: KillWorkerInput): Promise<void> {
		await this.withMutation(async () => {
			const forkId = this.workerForkIds.get(input.workerId) ?? input.workerId;
			await this.publish("agent_finished", {
				agentId: input.workerId,
				forkId,
				willRetry: false,
				killed: true,
				stopReason: "killed",
				reason: input.reason ?? "killed by leader",
			});
			await this.publish("worker_killed", {
				agentId: input.workerId,
				forkId,
				reason: input.reason ?? "killed by leader",
			});
		});
	}

	/**
	 * Create a task in the task graph. Publishes a `task.created` event.
	 */
	async createTask(input: CreateTaskInput): Promise<{ taskId: string }> {
		return this.withMutation(async () => {
			const taskId = input.taskId && String(input.taskId).length > 0 ? String(input.taskId) : randomUUID();
			await this.publish("task.created", {
				taskId,
				title: input.title,
				description: input.description ?? "",
				parentId: input.parentId ?? null,
				assignee: input.assignee ?? null,
			});
			if (input.assignee) {
				this.taskAssignees.set(taskId, input.assignee);
			}
			return { taskId };
		});
	}

	/**
	 * Update a task's status. Publishes a `task.status_changed` event.
	 */
	async updateTask(input: UpdateTaskInput): Promise<void> {
		await this.publish("task.status_changed", {
			taskId: input.taskId,
			status: input.status,
		});
	}

	/**
	 * Request current goal completion. The orchestrator verifies before publishing `goal.finished`.
	 */
	async finishGoal(input: FinishGoalInput): Promise<void> {
		await this.publish("goal.completion_requested", {
			evidence: input.evidence,
			sessionId: this.sessionId,
		});
	}

	/**
	 * Pass the turn (no action needed). Publishes a `turn_passed` event.
	 */
	async pass(input: PassInput): Promise<void> {
		await this.publish("turn_passed", {
			message: input.message ?? "pass",
			sessionId: this.sessionId,
		});
	}

	/**
	 * Escalate to the observer/advisor. Publishes an `escalation_requested` event.
	 */
	async escalate(input: EscalateInput): Promise<void> {
		await this.publish("escalation_requested", {
			justification: input.justification,
			message: input.message,
			sessionId: this.sessionId,
		});
	}

	/**
	 * Reassign a task to a different worker.
	 *
	 * Magnitude alpha22 semantics: the previously-assigned worker keeps its
	 * identity, fork, and conversation history — only the task binding moves.
	 * We therefore do NOT publish `agent_finished{killed}` / `worker_killed`
	 * for the prior worker (that would destroy its session). The old worker
	 * stays alive and the task is rebound via the existing `task.assigned`
	 * event, which the orchestrator's task dispatcher forwards to the new
	 * assignee.
	 */
	async reassignWorker(input: ReassignWorkerInput): Promise<void> {
		await this.withMutation(async () => {
			const oldWorkerId = this.taskAssignees.get(input.taskId);
			if (oldWorkerId && oldWorkerId !== input.workerId) {
				// Preserve the old worker's live fork/session. The task binding below
				// is the only state that changes.
				void oldWorkerId;
			}
			this.taskAssignees.set(input.taskId, input.workerId);
			await this.publish("task.assigned", {
				taskId: input.taskId,
				assignee: input.workerId,
			});
		});
	}

	/**
	 * Send a message to the advisor. Publishes an `advisor_messaged` event.
	 */
	async messageAdvisor(input: MessageAdvisorInput): Promise<void> {
		await this.publish("advisor_messaged", {
			message: input.message,
			sessionId: this.sessionId,
		});
	}

	/**
	 * Resolve the worker (agent) ID bound to a task ID. Returns undefined if no
	 * worker was spawned with that taskId. Used by the `kill_worker` handler so
	 * workers can be killed by task ID (alpha22 semantics).
	 */
	workerIdForTask(taskId: string): string | undefined {
		return this.taskAssignees.get(taskId);
	}
}
