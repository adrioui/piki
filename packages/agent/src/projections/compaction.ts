// packages/agent/src/projections/compaction.ts
//
// CompactionProjection tracks per-fork context-compaction lifecycle. It is a
// forked projection whose fork state is a tagged FSM (`idle` | `compacting` |
// `pendingInjection`) carrying `contextLimitBlocked` and `shouldCompact`.
//
// `TurnController` reads `compactionFork.contextLimitBlocked` to decide whether a
// fork is allowed to start a new turn.

import { defineForkedProjection } from "@piki/event-core";

export type CompactionPhase = "idle" | "compacting" | "pendingInjection";

export interface CompactionForkState {
	readonly _tag: CompactionPhase;
	readonly contextLimitBlocked: boolean;
	readonly shouldCompact: boolean;
}

const initialIdle: CompactionForkState = {
	_tag: "idle",
	contextLimitBlocked: false,
	shouldCompact: false,
};

// ─── Signal helpers ─────────────────────────────────────────────────────────
// Emit `shouldCompactChanged` whenever the `shouldCompact` flag flips between the
// old and new fork state, so the compaction worker (subscribed to the signal) can
// react. The `context_limit_hit` event drives `shouldCompact` true when idle.

function emitIfShouldCompactChanged(
	oldFork: CompactionForkState,
	newFork: CompactionForkState,
	forkId: string | null,
	emit: Record<string, (value: unknown) => void>,
): void {
	if (oldFork.shouldCompact !== newFork.shouldCompact) {
		emit.shouldCompactChanged({ forkId, shouldCompact: newFork.shouldCompact });
	}
}

// ─── Projection factory ───────────────────────────────────────────────────────

export const CompactionProjection = defineForkedProjection()({
	name: "Compaction",
	initialFork: initialIdle,
	reads: [],
	signals: {
		shouldCompactChanged: { name: "Compaction/shouldCompactChanged" },
	},
	eventHandlers: {
		compaction_started: ({ event, fork, emit }) => {
			const next: CompactionForkState = { ...fork, _tag: "compacting", shouldCompact: false };
			emitIfShouldCompactChanged(fork, next, event.forkId, emit);
			return next;
		},
		compaction_prepared: ({ event, fork, emit }) => {
			const next: CompactionForkState = { ...fork, _tag: "pendingInjection", shouldCompact: false };
			emitIfShouldCompactChanged(fork, next, event.forkId, emit);
			return next;
		},
		compaction_injected: ({ event, fork, emit }) => {
			const next: CompactionForkState = {
				...fork,
				_tag: "idle",
				shouldCompact: false,
				contextLimitBlocked: false,
			};
			emitIfShouldCompactChanged(fork, next, event.forkId, emit);
			return next;
		},
		compaction_failed: ({ event, fork, emit }) => {
			if (fork._tag === "idle") return fork;
			const next: CompactionForkState = { ...fork, _tag: "idle", shouldCompact: false, contextLimitBlocked: false };
			emitIfShouldCompactChanged(fork, next, event.forkId, emit);
			return next;
		},
		// A hard context limit was hit: mark `contextLimitBlocked` and, when idle,
		// drive `shouldCompact` true so the compaction worker triggers.
		context_limit_hit: ({ event, fork, emit }) => {
			const next: CompactionForkState = {
				...fork,
				contextLimitBlocked: true,
				shouldCompact: fork._tag === "idle" ? true : fork.shouldCompact,
			};
			emitIfShouldCompactChanged(fork, next, event.forkId, emit);
			return next;
		},
	},
});
