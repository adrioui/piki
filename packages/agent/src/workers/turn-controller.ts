// packages/agent/src/workers/turn-controller.ts
//
// TurnController decides when a fork is allowed to start a new turn. It is a
// plain `worker.define()` (non-forked) with an `onProjectionsSettled` handler
// that:
//   - reads all forks of `TurnProjection` and `CompactionProjection`
//   - for each idle fork with a due trigger (and not context-limit-blocked),
//     publishes a `turn_started` event

import { randomUUID } from "node:crypto";
import { defineWorker } from "@piki/event-core";
import { Effect } from "effect";
import { CompactionProjection } from "../projections/compaction.ts";
import { TurnProjection, type TurnTrigger } from "../projections/turn.ts";

// ─── Trigger helpers ───────────────────────────────────────────────────────────

function resolveChainId(triggers: ReadonlyArray<TurnTrigger>): string | null {
	for (const trigger of triggers) {
		if (trigger._tag === "chain_continue") return trigger.chainId;
	}
	return null;
}

function isTriggerDue(trigger: TurnTrigger, now: number): boolean {
	if (trigger._tag !== "chain_continue") return true;
	return trigger.notBefore === undefined || trigger.notBefore <= now;
}

// ─── Business logic (Effect.fn for tracing) ──────────────────────────────────

const startTurnForFork = Effect.fn("TurnController.startTurnForFork")(function* (
	forkId: string | null,
	turnFork: { readonly triggers: ReadonlyArray<TurnTrigger> },
	publish: (event: unknown) => Effect.Effect<void, unknown, unknown>,
) {
	const turnId = randomUUID();
	const chainId = resolveChainId(turnFork.triggers) ?? randomUUID();
	yield* publish({ type: "turn_started", forkId, turnId, chainId });
});

// ─── Worker definition ───────────────────────────────────────────────────────────────────

export const TurnController = defineWorker()({
	name: "TurnController",
	onProjectionsSettled: ({ publish, read }) =>
		Effect.gen(function* () {
			const turnForks = yield* read.allForks(TurnProjection);
			const compactionForks = yield* read.allForks(CompactionProjection);
			const now = Date.now();
			for (const [forkId, turnFork] of turnForks) {
				const compactionFork = compactionForks.get(forkId);
				const hasDueTrigger = turnFork.triggers.some((trigger: TurnTrigger) => isTriggerDue(trigger, now));
				const isTurnIdle = turnFork._tag === "idle";
				const contextLimitBlocked = compactionFork?.contextLimitBlocked === true;
				const canStart = hasDueTrigger && isTurnIdle && !contextLimitBlocked;
				if (canStart) {
					yield* startTurnForFork(forkId, turnFork, publish);
				}
			}
		}),
});
