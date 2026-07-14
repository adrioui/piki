import type { EventEnvelope, RoleContext, RoleDefinition } from "@piki/event-core/types";

import {
	TaskWorkerSignals,
	type TaskWorkerSnapshot,
	type TaskWorkerState,
	type TaskWorkerStatus,
} from "../projections/task-worker.ts";

// ─── Minimal projection state interfaces ────────────────────────────────────
// These describe the shapes the role reads from the TaskGraph and AgentStatus
// projections via `projections.get()`. Kept local to avoid coupling.

/** Minimal shape of a task as stored in the TaskGraph projection. */
interface TaskEntry {
	id: string;
	title: string;
	status: string;
	parentId: string | null;
	assignee: string | null;
	updatedAt?: string;
	worker?: {
		agentId: string | null;
		forkId: string | null;
		role: string | null;
	} | null;
	children: string[];
}

/** Minimal shape of the TaskGraph projection state. */
interface TaskGraphLike {
	tasks: Map<string, TaskEntry>;
	rootTaskIds: string[];
}

/** Minimal shape of an agent entry in the AgentStatus projection. */
interface AgentEntry {
	role?: string;
	status: string;
	taskId?: string;
}

/** Minimal shape of the AgentStatus projection state. */
interface AgentStatusLike {
	agents: Map<string, AgentEntry>;
}

// ─── Task-tree helpers ───────────────────────────────────────────────────────────

/**
 * DFS walk over the task tree, producing an ordered list of task IDs and
 * per-task depth. Computes the flattened task tree (lines 82647-82667).
 *
 * Adapted: pi's Task uses `children` (not `childIds`) and roots are found by
 * filtering tasks with no `rootTaskIds` array; instead we check `parentId`.
 */
export function flattenTaskTree(taskGraph: TaskGraphLike): {
	orderedTaskIds: string[];
	depthByTaskId: Record<string, number>;
} {
	const orderedTaskIds: string[] = [];
	const depthByTaskId: Record<string, number> = {};

	const visit = (taskId: string, depth: number): void => {
		const task = taskGraph.tasks.get(taskId);
		if (!task) return;
		orderedTaskIds.push(taskId);
		depthByTaskId[taskId] = depth;
		for (const childId of task.children) {
			visit(childId, depth + 1);
		}
	};

	// Use rootTaskIds if available (standard pattern), otherwise derive from parentId
	if ("rootTaskIds" in taskGraph && Array.isArray(taskGraph.rootTaskIds)) {
		for (const rootId of taskGraph.rootTaskIds) {
			visit(rootId, 0);
		}
	} else {
		for (const [id, task] of taskGraph.tasks) {
			if (!task.parentId) {
				visit(id, 0);
			}
		}
	}

	return { orderedTaskIds, depthByTaskId };
}

/**
 * Derive the assignee descriptor for a task snapshot.
 * Computes the task worker assignee (lines 82733-82744).
 *
 * Adapted for pi: pi's Task has `assignee: string | null` instead of
 * the `worker` object. We look up the agent in AgentStatus to
 * determine the role.
 */
export function deriveTaskWorkerAssignee(task: TaskEntry, agentState: AgentStatusLike): TaskWorkerSnapshot["assignee"] {
	if (task.worker) {
		return {
			kind: "worker",
			role: task.worker.role ?? null,
			agentId: task.worker.agentId ?? null,
			forkId: task.worker.forkId ?? null,
		};
	}

	// Pi adaptation: check assignee field + AgentStatus for role
	if (task.assignee === "user") {
		return { kind: "user" };
	}

	if (task.assignee && task.assignee.length > 0) {
		// Look up agent to get role info
		const agent = agentState.agents.get(task.assignee);
		return {
			kind: "worker",
			role: agent?.role ?? null,
			agentId: task.assignee,
			forkId: null,
		};
	}

	return { kind: "none" };
}

/**
 * Derive the worker-state kind for a single task.
 * Computes the per-task worker state (lines 82696-82730).
 *
 * SIMPLIFIED: pi lacks HarnessState / tool-handle tracking, so we skip
 * the `spawning` and `killing` detection (findActiveToolCallId). Only the
 * `working` / `idle` / `unassigned` branches are retained, based on the
 * linked agent's status in AgentStatus and the presence of activity entries.
 */
export function deriveWorkerState(args: {
	task: TaskEntry;
	agentState: AgentStatusLike;
	activityByForkId: Record<string, { activeSince: string | null }>;
}): TaskWorkerStatus {
	const { task, agentState, activityByForkId } = args;

	// Determine the worker identifier (forkId from the worker object, or assignee in pi)
	const workerForkId = task.worker?.forkId ?? task.assignee ?? null;
	const workerAgentId = task.worker?.agentId ?? task.assignee ?? null;

	if (!workerForkId && !workerAgentId) {
		return "unassigned";
	}

	// Look up the linked agent by ID
	const linkedAgent = workerAgentId ? agentState.agents.get(workerAgentId) : undefined;

	// Check activity by forkId first, then by agentId as fallback
	const activity =
		(workerForkId ? activityByForkId[workerForkId] : undefined) ??
		(workerAgentId ? activityByForkId[workerAgentId] : undefined);

	if (linkedAgent?.status === "working") {
		return "working";
	}

	if (linkedAgent || activity) {
		return "idle";
	}

	return "unassigned";
}

/**
 * Recompute the full set of per-task snapshots.
 * Recomputes the aggregate worker state (lines 82766-82795).
 */
export function recomputeState(args: {
	taskGraph: TaskGraphLike;
	agentState: AgentStatusLike;
	workerActivityByForkId: Record<string, { activeSince: string | null }>;
}): {
	orderedTaskIds: string[];
	snapshots: Record<string, TaskWorkerSnapshot>;
} {
	const { orderedTaskIds, depthByTaskId } = flattenTaskTree(args.taskGraph);
	const snapshots: Record<string, TaskWorkerSnapshot> = {};

	for (const taskId of orderedTaskIds) {
		const task = args.taskGraph.tasks.get(taskId);
		if (!task) continue;

		snapshots[taskId] = {
			taskId: task.id,
			title: task.title,
			status: task.status,
			parentId: task.parentId,
			depth: depthByTaskId[taskId] ?? 0,
			updatedAt: task.updatedAt ?? "",
			assignee: deriveTaskWorkerAssignee(task, args.agentState),
			workerState: deriveWorkerState({
				task,
				agentState: args.agentState,
				activityByForkId: args.workerActivityByForkId,
			}),
		};
	}

	return { orderedTaskIds, snapshots };
}

// ─── Events the role reacts to ──────────────────────────────────────────────

const SUBSCRIBED_EVENTS = new Set([
	"agent_created",
	"turn_started",
	"turn_outcome",
	"interrupt",
	"agent_killed",
	"subagent_user_killed",
	"worker_idle_closed",
	"task_created",
	"task_updated",
	"task_assigned",
	"task_cancelled",
	"tool_event",
	"agent_task_changed",
	"task.status_changed",
	"task.assigned",
	"agent_finished",
]);

// ─── Role factory ───────────────────────────────────────────────────────────

/**
 * Create the TaskWorker companion role.
 *
 * This role is the "Choice A split" counterpart to the TaskWorker projection:
 * the projection handles pure per-fork activity tracking in its `reduce`,
 * while this role performs the cross-projection join (reading TaskGraph +
 * AgentStatus) to compute per-task worker snapshots.
 *
 * On each subscribed event, the role reads the latest TaskGraph and AgentStatus
 * state, runs `recomputeState`, and emits a `TaskWorker/snapshotUpdated` signal
 * carrying the computed snapshots.
 */
export function createTaskWorkerRole<TEvent extends EventEnvelope = EventEnvelope>(): RoleDefinition<TEvent> {
	return {
		name: "TaskWorkerRole",

		match: (event: TEvent): boolean => {
			return SUBSCRIBED_EVENTS.has(event.type);
		},

		run: (ctx: RoleContext<TEvent>): void => {
			const taskGraph = ctx.projections.get<TaskGraphLike>("TaskGraph");
			const agentState = ctx.projections.get<AgentStatusLike>("AgentStatus");
			const twState = ctx.projections.get<TaskWorkerState>("TaskWorker");

			if (!taskGraph || !agentState) return;

			const result = recomputeState({
				taskGraph,
				agentState,
				workerActivityByForkId: twState?.workerActivityByForkId ?? {},
			});

			ctx.emitSignal({
				type: TaskWorkerSignals.snapshotUpdated.type,
				payload: {
					orderedTaskIds: result.orderedTaskIds,
					snapshots: result.snapshots,
				},
			});
		},
	};
}
