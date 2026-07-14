// packages/agent/src/workers/retry-controller.ts
//
// RetryController schedules a retry wake after a connection failure. It is a
// forked `worker.defineForked()` that:
//   - activates on `agent_created`
//   - completes on `agent_killed` / `worker_user_killed` / `worker_idle_closed`
//   - on `turn_outcome`, if the outcome is a `ConnectionFailure`, reads the
//     fork's `TurnProjection`, finds the pending `chain_continue` trigger with a
//     `notBefore` timestamp, sleeps until that time, and publishes a `wake`
//     event to retry the turn
//
// Implemented idiomatically with Effect.

import { defineForkedWorker as defineForked } from "@piki/event-core";
import { Logger } from "@piki/logger";
import { Effect } from "effect";
import { TurnProjection } from "../projections/turn.ts";

const CONNECTION_FAILURE = "ConnectionFailure";

export const RetryController = defineForked({
	name: "RetryController",
	forkLifecycle: {
		activateOn: "agent_created",
		completeOn: ["agent_killed", "worker_user_killed", "worker_idle_closed"],
	},
	eventHandlers: {
		turn_outcome: (event, publish, read) =>
			Effect.gen(function* () {
				const outcome = event.outcome;
				if (outcome?._tag !== CONNECTION_FAILURE) return;
				const forkId = event.forkId;
				if (forkId === null) return;

				const logger = yield* Logger;
				const scoped = yield* logger.namespace("RetryController");

				const fork = yield* read(TurnProjection, forkId);
				let nextNotBefore: number | null = null;
				for (const trigger of fork.triggers) {
					if (trigger._tag === "chain_continue" && trigger.notBefore !== undefined) {
						if (nextNotBefore === null || trigger.notBefore > nextNotBefore) {
							nextNotBefore = trigger.notBefore;
						}
					}
				}

				const delayMs = nextNotBefore === null ? 0 : Math.max(0, nextNotBefore - Date.now());

				yield* scoped.log("info", {
					message: "RetryController: scheduling retry wake after ConnectionFailure",
					forkId,
					delayMs,
				});

				yield* Effect.sleep(delayMs);
				yield* publish({ type: "wake", forkId });
			}),
		worker_user_killed: (event) =>
			Effect.gen(function* () {
				if (event.forkId === null) return;
				return yield* Effect.interrupt;
			}),
		worker_idle_closed: (event) =>
			Effect.gen(function* () {
				if (event.forkId === null) return;
				return yield* Effect.interrupt;
			}),
	},
});
