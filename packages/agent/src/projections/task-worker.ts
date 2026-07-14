import {
	createSignal,
	type EventEnvelope,
	type ProjectionDefinition,
	type SignalDefinition,
} from "@piki/event-core/types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkerActivityEntry {
	forkId: string;
	activeSince: string | null;
	accumulatedMs: number;
	completedAt: string | null;
	resumeCount: number;
}

/** Per-task worker-state kind. */
export type TaskWorkerStatus = "spawning" | "killing" | "working" | "idle" | "unassigned";

export interface TaskWorkerSnapshot {
	taskId: string;
	title: string;
	status: string;
	parentId: string | null;
	depth: number;
	updatedAt: string;
	assignee:
		| { kind: "worker"; role: string | null; agentId: string | null; forkId: string | null }
		| { kind: "user" }
		| { kind: "none" };
	workerState: TaskWorkerStatus;
}

export interface TaskWorkerState {
	/** Pure, projection-owned: per-fork accumulated activity. */
	workerActivityByForkId: Record<string, WorkerActivityEntry>;
	/** Join-derived, populated by the companion role (Choice A). Initial empty until first
	 *  TaskWorkerRole run after a subscribed event. */
	orderedTaskIds: string[];
	/** Join-derived snapshots keyed by taskId. */
	snapshots: Record<string, TaskWorkerSnapshot>;
}

export const TaskWorkerSignals = {
	snapshotUpdated: createSignal(
		"TaskWorker/snapshotUpdated",
		"Emitted (ephemeral) by the TaskWorker role after recomputing per-task worker snapshots",
	),
} as const;

// ─── Sentinel for main fork ─────────────────────────────────────────────────

const MAIN = "__main__";

// ─── Pure activity helpers ───────────────────────────────────────────────────

export function ensureWorkerActivity(
	activity: Record<string, WorkerActivityEntry>,
	forkId: string,
): Record<string, WorkerActivityEntry> {
	if (activity[forkId]) return activity;
	return {
		...activity,
		[forkId]: {
			forkId,
			activeSince: null,
			accumulatedMs: 0,
			completedAt: null,
			resumeCount: 0,
		},
	};
}

export function markWorkerWorking(
	activity: Record<string, WorkerActivityEntry>,
	forkId: string,
	timestamp: string,
): Record<string, WorkerActivityEntry> {
	const entry = activity[forkId];
	if (!entry) {
		// Auto-create if missing (defensive)
		return {
			...activity,
			[forkId]: {
				forkId,
				activeSince: timestamp,
				accumulatedMs: 0,
				completedAt: null,
				resumeCount: 0,
			},
		};
	}
	if (entry.activeSince) return activity; // already working
	return {
		...activity,
		[forkId]: {
			...entry,
			activeSince: timestamp,
			resumeCount: entry.completedAt ? entry.resumeCount + 1 : entry.resumeCount,
		},
	};
}

export function markWorkerIdle(
	activity: Record<string, WorkerActivityEntry>,
	forkId: string,
	timestamp: string,
): Record<string, WorkerActivityEntry> {
	const entry = activity[forkId];
	if (!entry || !entry.activeSince) return activity; // not working
	const elapsed = new Date(timestamp).getTime() - new Date(entry.activeSince).getTime();
	return {
		...activity,
		[forkId]: {
			...entry,
			activeSince: null,
			accumulatedMs: entry.accumulatedMs + Math.max(0, elapsed),
			completedAt: timestamp,
		},
	};
}

export function removeWorkerActivity(
	activity: Record<string, WorkerActivityEntry>,
	forkId: string,
): Record<string, WorkerActivityEntry> {
	if (!activity[forkId]) return activity;
	const next = { ...activity };
	delete next[forkId];
	return next;
}

/** Check if a turn_outcome signals a continuation (chain-continue) rather than a terminal idle. */
export function outcomeWillChainContinue(outcome: unknown): boolean {
	if (typeof outcome === "string") {
		return outcome === "continue" || outcome === "chain" || outcome === "chaining";
	}
	if (outcome && typeof outcome === "object") {
		const o = outcome as Record<string, unknown>;
		if (o.chaining === true || o.willContinue === true) return true;
		if (typeof o.reason === "string") {
			return o.reason === "continue" || o.reason === "chain" || o.reason === "chaining";
		}
	}
	return false;
}

// ─── Projection factory ─────────────────────────────────────────────────────

export function createTaskWorkerProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	TaskWorkerState
> {
	return {
		name: "TaskWorker",
		reads: ["TaskGraph", "AgentStatus"],
		writes: [],
		signals: Object.values(TaskWorkerSignals) as SignalDefinition[],
		initialState: (): TaskWorkerState => ({
			workerActivityByForkId: {},
			orderedTaskIds: [],
			snapshots: {},
		}),
		reduce: reduceTaskWorker as (state: TaskWorkerState, event: TEvent) => TaskWorkerState,
	};
}

// ─── Reduce function ────────────────────────────────────────────────────────

function reduceTaskWorker<TEvent extends EventEnvelope = EventEnvelope>(
	state: TaskWorkerState,
	event: TEvent,
): TaskWorkerState {
	const p = (event.payload ?? {}) as Record<string, unknown>;
	const forkId = typeof p.forkId === "string" ? p.forkId : null;
	const ts = event.timestamp;

	switch (event.type) {
		case "agent_created": {
			const id = forkId ?? MAIN;
			return {
				...state,
				workerActivityByForkId: ensureWorkerActivity(state.workerActivityByForkId, id),
			};
		}

		case "turn_started": {
			if (forkId === null) return state;
			return {
				...state,
				workerActivityByForkId: markWorkerWorking(state.workerActivityByForkId, forkId, ts),
			};
		}

		case "turn_outcome": {
			if (forkId === null) return state;
			if (outcomeWillChainContinue(p.outcome)) return state;
			return {
				...state,
				workerActivityByForkId: markWorkerIdle(state.workerActivityByForkId, forkId, ts),
			};
		}

		case "interrupt": {
			if (forkId === null) return state;
			return {
				...state,
				workerActivityByForkId: markWorkerIdle(state.workerActivityByForkId, forkId, ts),
			};
		}

		case "agent_killed":
		case "subagent_user_killed":
		case "worker_idle_closed":
		case "worker_killed":
		case "agent_finished": {
			if (!forkId) return state;
			return {
				...state,
				workerActivityByForkId: removeWorkerActivity(state.workerActivityByForkId, forkId),
			};
		}

		default:
			return state;
	}
}
