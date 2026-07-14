// packages/agent/src/workers/cortex.ts
//
// Cortex is the main execution worker. It is a forked `worker.defineForked()`
// that:
//   - activates on `agent_created`
//   - completes on `agent_killed` / `worker_user_killed` / `worker_idle_closed`
//   - on `turn_started`, resolves the fork's layer + toolkit + model, builds the
//     prompt via `windowToPrompt`, runs a harness turn via the harness adapter,
//     and publishes a `turn_outcome` event.
//
// piki's turn execution currently lives in `SessionOrchestrator` +
// `WorkerExecutor` + `ForkRuntime` (the leader path), and the event-core
// `defineForked` engine is not yet wired into the turn flow. This file is a
// structural stub that registers the Cortex forked worker and documents the
// dependency surface it needs before the real execution logic can be filled in.
//
// BLOCKED: real Cortex turn execution requires the harness-adapter + ExecutionManager + AgentModelResolver + projection services listed above, none of which are wired into the packages/agent event-core worker engine yet. Cortex remains an acknowledgement stub to keep the build green:
//   - ExecutionManager service (`execManager.getObservables` / `getForkLayer`)
//   - createHarnessAdapter / buildStandardHooks (harness event -> event-core mapping)
//   - SessionContextProjection / AgentStatusProjection / WindowProjection /
//     TurnProjection / HarnessStateProjection / DetachedProcessProjection as
//     `projection.define()` services readable via the worker `read` fn
//   - getEffectiveToolkit / isToolKey / getForkInfo / getAgentDefinition /
//     getAgentByForkId (toolkit + role resolution)
//   - AgentModelResolver as a resolvable service (model by role/fork)
//   - ImageDescriptionServiceTag (vision image-description fallback)
//   - ShadowVcs as a service with `.getTools()`
//   - AmbientServiceTag + ConfigAmbient / SessionOptionsAmbient / SkillsAmbient
//   - TurnContextTag, MAX_RETRIES
//   - finalizeModelAttemptFailure / buildInterruptedTurnOutcome
//   - createAgentFormatter / createToolResultFormatter
//
// Until those land, Cortex only acknowledges `turn_started` and does not execute
// the turn. The coordinator-issued directive is to keep the build green.

import { defineForkedWorker as defineForked } from "@piki/event-core";
import { Logger } from "@piki/logger";
import { Effect } from "effect";

export const Cortex = defineForked({
	name: "Cortex",
	forkLifecycle: {
		activateOn: "agent_created",
		completeOn: ["agent_killed", "worker_user_killed", "worker_idle_closed"],
	},
	eventHandlers: {
		turn_started: (event: any, _publish: any, _read: any) =>
			Effect.gen(function* () {
				const { forkId, turnId } = event as { forkId: string | null; turnId: string };
				const logger = yield* Logger;
				const scoped = yield* logger.namespace("Cortex");
				yield* scoped.log("info", {
					message: "Cortex: turn_started received",
					forkId,
					turnId,
					status: "stub",
				});
				// Execution logic intentionally omitted — see BLOCKED above.
				// above. When wired, this branch resolves the fork layer/toolkit/
				// model, builds the prompt, runs the harness turn, and publishes a
				// `turn_outcome` event.
				return;
			}),
		worker_user_killed: (event: any) =>
			Effect.gen(function* () {
				if (event.forkId === null) return;
				return yield* Effect.interrupt;
			}),
		worker_idle_closed: (event: any) =>
			Effect.gen(function* () {
				if (event.forkId === null) return;
				return yield* Effect.interrupt;
			}),
	},
});
