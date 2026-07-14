// packages/agent/src/workers/compaction-worker.ts
//
// CompactionWorker drives context compaction per fork. It is a forked
// `defineForkedWorker()` that:
//   - activates on `agent_created`
//   - completes on `agent_killed` / `worker_user_killed` / `worker_idle_closed`
//   - on the `CompactionProjection` `shouldCompactChanged` signal (true), reads
//     the fork's window + role + soft cap, publishes `compaction_started`, runs
//     a compaction turn via `CompactionTurnRunner`, and publishes
//     `compaction_prepared` / `compaction_failed`
//   - on `turn_outcome`, if the `CompactionProjection` fork state is
//     `pendingInjection`, publishes `compaction_injected`
//
// Config (soft cap) arrives through the `CompactionConfigAmbient`, populated
// upstream by the coding-agent assembly. `CompactionTurnRunner` has a Noop
// fallback so the worker never crashes the fork when the runner is unconfigured.

import { AmbientServiceTag, defineForkedWorker as defineForked } from "@piki/event-core";
import { Effect } from "effect";
import { type CompactionForkState, CompactionProjection } from "../projections/compaction.ts";
import { type WindowForkState, WindowProjection } from "../projections/window-projection.ts";
import { CompactionTurnRunner } from "./compaction/turn-runner.ts";
import { computeCompactionSizing, getCompactionConfig, getRoleId } from "./compaction/util.ts";

export const CompactionWorker = defineForked({
	name: "CompactionWorker",
	forkLifecycle: {
		activateOn: "agent_created",
		completeOn: ["agent_killed", "worker_user_killed", "worker_idle_closed"],
	},
	signalHandlers: (on) => [
		on(CompactionProjection.signals.shouldCompactChanged, (value, publish, read) =>
			Effect.gen(function* () {
				if (!value.shouldCompact) return;
				const forkId = value.forkId as string | null;
				const ambientService = yield* AmbientServiceTag;
				const cfg = getCompactionConfig(ambientService);
				const window = (yield* read(WindowProjection, forkId)) as WindowForkState;
				const roleId = yield* getRoleId(read, forkId);
				if (!roleId) return;
				const { compactedMessageCount } = computeCompactionSizing(window.messages, cfg.softCap);
				yield* publish({ type: "compaction_started", forkId, compactedMessageCount });
				const runner = yield* CompactionTurnRunner;
				const result = yield* runner
					.run({
						forkId,
						roleId,
						windowMessages: window.messages,
						softCap: cfg.softCap,
						compactedMessageCount,
					})
					.pipe(Effect.either);
				if (result._tag === "Left") {
					yield* publish({ type: "compaction_failed", forkId, error: result.left.reason });
					return;
				}
				yield* publish({
					type: "compaction_prepared",
					forkId,
					turn: result.right.turn,
					compactionOutcome: result.right.compactionOutcome,
					inputTokens: result.right.inputTokens,
					outputTokens: result.right.outputTokens,
				});
			}),
		),
	],
	eventHandlers: {
		turn_outcome: (event, publish, read) =>
			Effect.gen(function* () {
				const forkId = (event as { forkId: string | null }).forkId;
				if (forkId === null) return;
				const compaction = (yield* read(CompactionProjection, forkId)) as CompactionForkState;
				if (compaction._tag !== "pendingInjection") return;
				yield* publish({ type: "compaction_injected", forkId });
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
