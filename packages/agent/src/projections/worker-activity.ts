import {
	createSignal,
	type EventEnvelope,
	type ProjectionDefinition,
	type Signal,
	type SignalDefinition,
} from "@piki/event-core/types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ActivityEntry {
	type: string;
	forkId: string;
	text?: string;
	timestamp: string;
}

export interface WorkerActivityState {
	/** Per-parent-fork accumulated activity entries (readable by the leader). */
	entriesByParent: Map<string, ActivityEntry[]>;
	/** Cursor per parent fork: how many entries have been "seen" (consumed by UI/role). */
	seenCursorByParent: Map<string, number>;
	/** Accumulated prose per forkId from message_chunk events (pending until turn_outcome). */
	pendingProse: Map<string, string>;
	/** message IDs currently being tracked per fork (only coordinator-bound messages). */
	userMessageIdsByFork: Map<string, Set<string>>;
	/** Parent fork lookup (forkId → parentForkId) derived from agent_created events. */
	forkParent: Map<string, string | null>;
	/** Timestamp of the most recent activity per parent fork. */
	lastActivityTimestamp: Map<string, string>;
	/** Pending signal payloads set by reduce, consumed by extractSignals. */
	pendingSignals: Array<{ parentForkId: string; entries: ActivityEntry[] }>;
}

// ─── Signals ────────────────────────────────────────────────────────────────

export const WorkerActivitySignals = {
	unseenActivityAvailable: createSignal(
		"SubagentActivity/unseenActivityAvailable",
		"Emitted when new worker activity entries arrive for a parent fork",
	),
} as const;

// ─── Projection factory ─────────────────────────────────────────────────────

export function createWorkerActivityProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	WorkerActivityState
> {
	return {
		name: "SubagentActivity",
		reads: [],
		writes: [],
		signals: Object.values(WorkerActivitySignals) as SignalDefinition[],
		initialState: (): WorkerActivityState => ({
			entriesByParent: new Map(),
			seenCursorByParent: new Map(),
			pendingProse: new Map(),
			userMessageIdsByFork: new Map(),
			forkParent: new Map(),
			lastActivityTimestamp: new Map(),
			pendingSignals: [],
		}),
		reduce: reduceWorkerActivity as (state: WorkerActivityState, event: TEvent) => WorkerActivityState,
		extractSignals: extractWorkerActivitySignals as (state: WorkerActivityState, event: TEvent) => Signal[],
	};
}

// ─── Reduce function ────────────────────────────────────────────────────────

function reduceWorkerActivity<TEvent extends EventEnvelope = EventEnvelope>(
	state: WorkerActivityState,
	event: TEvent,
): WorkerActivityState {
	const p = (event.payload ?? {}) as Record<string, unknown>;
	const forkId = typeof p.forkId === "string" ? (p.forkId as string) : null;

	// Clear pending signals from previous event cycle.
	const base = state.pendingSignals.length > 0 ? { ...state, pendingSignals: [] } : state;

	switch (event.type) {
		case "agent_created": {
			if (!forkId) return base;
			const parentRaw = p.parentForkId;
			const parentForkId = typeof parentRaw === "string" ? parentRaw : null;
			return {
				...base,
				forkParent: new Map(base.forkParent).set(forkId, parentForkId),
			};
		}

		case "message_start": {
			if (forkId === null) return base;
			const dest = p.destination as Record<string, unknown> | undefined;
			if (!dest || dest.kind !== "coordinator") return base;
			const msgId = typeof p.id === "string" ? p.id : null;
			if (!msgId) return base;
			const existing = base.userMessageIdsByFork.get(forkId) ?? new Set<string>();
			const next = new Set(existing);
			next.add(msgId);
			return {
				...base,
				userMessageIdsByFork: new Map(base.userMessageIdsByFork).set(forkId, next),
			};
		}

		case "message_chunk": {
			if (forkId === null) return base;
			const ids = base.userMessageIdsByFork.get(forkId);
			const msgId = typeof p.id === "string" ? p.id : null;
			if (!ids || !msgId || !ids.has(msgId)) return base;
			const text = typeof p.text === "string" ? p.text : "";
			const existing = base.pendingProse.get(forkId) ?? "";
			return {
				...base,
				pendingProse: new Map(base.pendingProse).set(forkId, existing + text),
			};
		}

		case "turn_started": {
			// The event.forkId is the child fork whose turn started.
			// Treat it as a parent forkId — emit unseen entries for that parent.
			const parentForkId = forkId;
			if (parentForkId === null) return base;
			const entries = base.entriesByParent.get(parentForkId) ?? [];
			const cursor = base.seenCursorByParent.get(parentForkId) ?? 0;
			if (entries.length <= cursor) return base;
			const unseen = entries.slice(cursor);
			// Store pending signal for extractSignals to emit.
			return {
				...base,
				seenCursorByParent: new Map(base.seenCursorByParent).set(parentForkId, entries.length),
				pendingSignals: [{ parentForkId, entries: unseen }],
			};
		}

		case "turn_outcome": {
			if (forkId === null) return base;
			const parentForkId = base.forkParent.get(forkId) ?? null;
			if (parentForkId === null) return base;
			const rawProse = base.pendingProse.get(forkId) ?? "";
			const prose = rawProse.trim() || undefined;
			const entry: ActivityEntry = {
				type: "turn_outcome",
				forkId,
				text: prose,
				timestamp: event.timestamp,
			};
			const existing = base.entriesByParent.get(parentForkId) ?? [];
			const newPendingProse = new Map(base.pendingProse);
			newPendingProse.delete(forkId);
			const newUserMessageIdsByFork = new Map(base.userMessageIdsByFork);
			newUserMessageIdsByFork.delete(forkId);
			return {
				...base,
				entriesByParent: new Map(base.entriesByParent).set(parentForkId, [...existing, entry]),
				pendingProse: newPendingProse,
				userMessageIdsByFork: newUserMessageIdsByFork,
				lastActivityTimestamp: new Map(base.lastActivityTimestamp).set(parentForkId, event.timestamp),
			};
		}

		case "agent_killed":
		case "subagent_user_killed":
		case "worker_idle_closed": {
			if (!forkId) return base;
			const pendingProse = new Map(base.pendingProse);
			pendingProse.delete(forkId);
			const userMessageIdsByFork = new Map(base.userMessageIdsByFork);
			userMessageIdsByFork.delete(forkId);
			return {
				...base,
				pendingProse,
				userMessageIdsByFork,
			};
		}

		default:
			return base;
	}
}

// ─── Signal extraction ──────────────────────────────────────────────────────

function extractWorkerActivitySignals<TEvent extends EventEnvelope = EventEnvelope>(
	state: WorkerActivityState,
	_event: TEvent,
): Signal[] {
	if (state.pendingSignals.length === 0) return [];
	return state.pendingSignals.map((pending) => ({
		type: WorkerActivitySignals.unseenActivityAvailable.type,
		payload: { parentForkId: pending.parentForkId, entries: pending.entries },
	}));
}
