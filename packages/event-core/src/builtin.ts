import { createSignal, type EventEnvelope, type ProjectionDefinition, type Signal } from "./types.ts";

// ─── Goal Projection ──────────────────────────────────────────────────────

export type GoalStatus = "idle" | "started" | "finished" | "incomplete";

export interface GoalState {
	goal: string | null;
	status: GoalStatus;
	evidence?: string;
	verdict?: string;
	source?: string;
}

export const GoalSignals = {
	injected: createSignal("Goal/injected", "A goal was injected into the session"),
	finished: createSignal("Goal/finished", "The goal was marked as finished"),
	incomplete: createSignal("Goal/incomplete", "The goal was marked as incomplete"),
};

/**
 * Goal projection.
 *
 * Goal lifecycle: injection → started → finished/incomplete
 *
 * Events that affect the goal:
 * - `goal.injected` → status = "started", goal = event.goal
 * - `goal.finished` → status = "finished"
 * - `goal.incomplete` → status = "incomplete"
 */
export function createGoalProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	GoalState
> {
	return {
		name: "Goal",
		reads: [],
		writes: [],
		signals: [GoalSignals.injected, GoalSignals.finished, GoalSignals.incomplete],
		initialState: (): GoalState => ({ goal: null, status: "idle" }),
		reduce: (state, event): GoalState => {
			switch (event.type) {
				case "goal.injected":
					return { goal: String((event.payload as Record<string, unknown>).goal ?? ""), status: "started" };
				case "goal.finished": {
					const payload = event.payload as Record<string, unknown>;
					return {
						...state,
						status: "finished",
						evidence: payload.evidence === undefined ? state.evidence : String(payload.evidence),
						verdict: payload.verdict === undefined ? state.verdict : String(payload.verdict),
						source: payload.source === undefined ? state.source : String(payload.source),
					};
				}
				case "goal.incomplete": {
					const payload = event.payload as Record<string, unknown>;
					return {
						...state,
						status: "incomplete",
						evidence: payload.evidence === undefined ? state.evidence : String(payload.evidence),
						verdict: payload.verdict === undefined ? state.verdict : String(payload.verdict),
						source: payload.source === undefined ? state.source : String(payload.source),
					};
				}
				default:
					return state;
			}
		},
		extractSignals: (state, event): Signal[] => {
			const signals: Signal[] = [];
			if (event.type === "goal.injected") {
				signals.push({ type: GoalSignals.injected.type, payload: state });
			} else if (event.type === "goal.finished") {
				signals.push({ type: GoalSignals.finished.type, payload: state });
			} else if (event.type === "goal.incomplete") {
				signals.push({ type: GoalSignals.incomplete.type, payload: state });
			}
			return signals;
		},
	};
}

// ─── TaskGraph Projection ──────────────────────────────────────────────────

export type TaskStatus = "pending" | "working" | "completed" | "cancelled";

export interface Task {
	id: string;
	title: string;
	status: TaskStatus;
	parentId: string | null;
	assignee: string | null;
	children: string[];
}

export interface TaskGraphState {
	tasks: Map<string, Task>;
	orderedTaskIds: string[];
	depthByTaskId: Map<string, number>;
}

export const TaskGraphSignals = {
	taskCreated: createSignal("TaskGraph/taskCreated", "A new task was created"),
	taskCompleted: createSignal("TaskGraph/taskCompleted", "A task was completed"),
	taskCancelled: createSignal("TaskGraph/taskCancelled", "A task was cancelled"),
	taskStatusChanged: createSignal("TaskGraph/taskStatusChanged", "A task's status changed"),
};

/** Flatten the task tree into ordered IDs with depth information. */
function flattenTaskTree(state: TaskGraphState): { orderedTaskIds: string[]; depthByTaskId: Map<string, number> } {
	const orderedTaskIds: string[] = [];
	const depthByTaskId = new Map<string, number>();

	function walk(id: string, depth: number): void {
		const task = state.tasks.get(id);
		if (!task) return;
		orderedTaskIds.push(id);
		depthByTaskId.set(id, depth);
		for (const childId of task.children) {
			walk(childId, depth + 1);
		}
	}

	// Walk from roots (tasks with no parent)
	for (const [id, task] of state.tasks) {
		if (!task.parentId) {
			walk(id, 0);
		}
	}

	return { orderedTaskIds, depthByTaskId };
}

/** Check if all children of a task are completed. */
export function canCompleteTask(state: TaskGraphState, taskId: string): boolean {
	const task = state.tasks.get(taskId);
	if (!task) return false;
	for (const childId of task.children) {
		const child = state.tasks.get(childId);
		if (child && child.status !== "completed") {
			return false;
		}
	}
	return true;
}

/** Check if a task can be assigned (must be pending). */
export function canAssignRecord(state: TaskGraphState, id: string, _assignee: string): boolean {
	const task = state.tasks.get(id);
	if (!task) return false;
	return task.status === "pending";
}

/** Check if a task can be completed (children must be completed first). */
export function canCompleteRecord(state: TaskGraphState, id: string): boolean {
	return canCompleteTask(state, id);
}

export const TASK_STATUSES: readonly TaskStatus[] = ["pending", "working", "completed", "cancelled"];

export function isTaskStatus(value: unknown): value is TaskStatus {
	return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * TaskGraph projection — tracks the task tree and per-task state.
 *
 * Manages parent-child task relationships with completion rules:
 * - Children must complete before parent
 * - Tasks can be assigned to workers
 * - Status transitions emit signals
 *
 * Events:
 * - `task.created` → create a new task
 * - `task.status_changed` → update task status (emits taskStatusChanged signal)
 * - `task.assigned` → assign a task to a worker
 */
export function createTaskGraphProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	TaskGraphState
> {
	return {
		name: "TaskGraph",
		reads: [],
		writes: [],
		signals: [
			TaskGraphSignals.taskCreated,
			TaskGraphSignals.taskCompleted,
			TaskGraphSignals.taskCancelled,
			TaskGraphSignals.taskStatusChanged,
		],
		initialState: (): TaskGraphState => ({
			tasks: new Map(),
			orderedTaskIds: [],
			depthByTaskId: new Map(),
		}),
		reduce: (state, event): TaskGraphState => {
			switch (event.type) {
				case "task.created": {
					const payload = event.payload as Record<string, unknown>;
					const taskId = String(payload.taskId ?? "");
					const title = String(payload.title ?? "");
					const parentId = payload.parentId ? String(payload.parentId) : null;
					const assignee = payload.assignee ? String(payload.assignee) : null;

					const task: Task = {
						id: taskId,
						title,
						status: "pending",
						parentId,
						assignee,
						children: [],
					};

					const tasks = new Map(state.tasks);
					tasks.set(taskId, task);

					if (parentId) {
						const parent = tasks.get(parentId);
						if (parent) {
							tasks.set(parentId, { ...parent, children: [...parent.children, taskId] });
						}
					}

					const next: TaskGraphState = { tasks, orderedTaskIds: [], depthByTaskId: new Map() };
					const flattened = flattenTaskTree(next);
					next.orderedTaskIds = flattened.orderedTaskIds;
					next.depthByTaskId = flattened.depthByTaskId;
					return next;
				}
				case "task.status_changed": {
					const payload = event.payload as Record<string, unknown>;
					const taskId = String(payload.taskId ?? "");
					const rawStatus = payload.status;
					if (!isTaskStatus(rawStatus)) return state;

					const tasks = new Map(state.tasks);
					const existing = tasks.get(taskId);
					if (!existing) return state;

					tasks.set(taskId, { ...existing, status: rawStatus });

					return {
						tasks,
						orderedTaskIds: state.orderedTaskIds,
						depthByTaskId: state.depthByTaskId,
					};
				}
				case "task.assigned": {
					const payload = event.payload as Record<string, unknown>;
					const taskId = String(payload.taskId ?? "");
					const assignee = String(payload.assignee ?? "");

					const tasks = new Map(state.tasks);
					const existing = tasks.get(taskId);
					if (!existing || existing.status !== "pending") return state;

					tasks.set(taskId, { ...existing, assignee, status: "working" });
					return {
						tasks,
						orderedTaskIds: state.orderedTaskIds,
						depthByTaskId: state.depthByTaskId,
					};
				}
				default:
					return state;
			}
		},
		extractSignals: (state, event): Signal[] => {
			const signals: Signal[] = [];
			if (event.type === "task.created") {
				const payload = event.payload as Record<string, unknown>;
				signals.push({ type: TaskGraphSignals.taskCreated.type, payload: { taskId: payload.taskId } });
			}
			if (event.type === "task.status_changed") {
				const payload = event.payload as Record<string, unknown>;
				const taskId = String(payload.taskId ?? "");
				const task = state.tasks.get(taskId);
				if (task) {
					signals.push({
						type: TaskGraphSignals.taskStatusChanged.type,
						payload: { taskId, previousStatus: payload.previousStatus, nextStatus: task.status },
					});
					if (task.status === "completed") {
						signals.push({ type: TaskGraphSignals.taskCompleted.type, payload: { taskId } });
					} else if (task.status === "cancelled") {
						signals.push({ type: TaskGraphSignals.taskCancelled.type, payload: { taskId } });
					}
				}
			}
			return signals;
		},
	};
}

// ─── Checkpoint Projection ─────────────────────────────────────────────────

export interface CheckpointEntry {
	id: string;
	timestamp: string;
	treeOID: string;
	kind: "turn-start" | "turn-end" | "manual" | "redo";
}

export interface CheckpointState {
	checkpoints: CheckpointEntry[];
	redoStack: string[];
}

/**
 * Checkpoint projection — tracks turn-boundary checkpoints.
 *
 * Checkpoint system that records work at each turn
 * boundary. Events:
 * - `checkpoint.created` → add a checkpoint entry
 * - `checkpoint.rolled_back` → truncate checkpoint list and update redo stack
 */
export function createCheckpointProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	CheckpointState
> {
	return {
		name: "Checkpoint",
		reads: [],
		writes: [],
		initialState: (): CheckpointState => ({ checkpoints: [], redoStack: [] }),
		reduce: (state, event): CheckpointState => {
			switch (event.type) {
				case "checkpoint.created": {
					const payload = event.payload as Record<string, unknown>;
					const entry: CheckpointEntry = {
						id: String(payload.id ?? ""),
						timestamp: String(payload.timestamp ?? event.timestamp),
						treeOID: String(payload.treeOID ?? ""),
						kind: (payload.kind as CheckpointEntry["kind"]) ?? "manual",
					};
					// New checkpoint invalidates redo history
					return {
						checkpoints: [...state.checkpoints, entry],
						redoStack: [],
					};
				}
				case "checkpoint.rolled_back": {
					const payload = event.payload as Record<string, unknown>;
					const targetId = String(payload.checkpointId ?? "");
					const idx = state.checkpoints.findIndex((c) => c.id === targetId);
					if (idx < 0) return state;
					const kept = state.checkpoints.slice(0, idx + 1);
					const removed = state.checkpoints.slice(idx + 1).map((c) => c.id);
					return {
						checkpoints: kept,
						redoStack: [...state.redoStack, ...removed],
					};
				}
				default:
					return state;
			}
		},
	};
}
