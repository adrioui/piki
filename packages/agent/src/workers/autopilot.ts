// packages/agent/src/workers/autopilot.ts
//
// Autopilot is the autonomous driver worker. It is a non-forked
// `worker.define()` that:
//   - has `signalHandlers: () => []` (it does not react to signals)
//   - on `onProjectionsSettled`, when no generation is in flight and autopilot
//     is enabled, waits until every agent is idle and the root turn is idle with
//     no pending triggers, then asks the advisor model for the next action:
//       - build the advisor system prompt
//       - read the window projection (root fork) and render it to a prompt via
//         `advisorWindowToPrompt({ windowState, systemPrompt, autopilotEnabled:
//         true, advisorLastAutopilotKnowledge: null })`
//       - cap maxTokens at `min(advisorModel.profile.maxOutputTokens, 1200)`
//       - publish `autopilot_generation_started`
//       - stream the advisor completion (providing `HttpClient`, retrying
//         connection errors per `connectionRetrySchedule` while the failure is
//         `UpstreamRetryable`, and catching all failures to publish an
//         `autopilot_outcome` error)
//       - collect advisor text, `parseAutopilotResponse`
//       - on `message`: publish `autopilot_outcome` success with the content
//       - on `finish`: publish `autopilot_outcome` success (when content is
//         non-null) and `autopilot_toggled` with `enabled: false`
//   - guards re-entrancy with a module-level `isGenerating` flag, reset in a
//     `finally` and a `catchAllCause` boundary
//
// piki's autopilot behavior is not yet wired into the event engine, and the
// dependency surface below does not exist. This file is a structural stub that
// registers the Autopilot worker and documents the control flow it must
// implement before the real generation logic can be filled in.
//
// BLOCKED: real Autopilot generation requires AutopilotStateProjection + AgentModelResolver service + HttpClient streaming + advisor prompt builders (buildAdvisorSystemPrompt/advisorWindowToPrompt/parseAutopilotResponse) + connectionRetrySchedule, none of which are wired into packages/agent yet. Autopilot remains an acknowledgement stub to keep the build green.

import { defineWorker as define } from "@piki/event-core";
import { Logger } from "@piki/logger";
import { Effect } from "effect";

/** Re-entrancy guard (module-level `isGenerating` flag). */
const isGenerating = false;

/**
 * The autonomous decision generation step. This resolves the advisor model,
 * advisor model, streams a completion, and parses the response into an autopilot
 * outcome. piki's dependencies are not yet available, so this documents the
 * flow and is a no-op until they land.
 */
export const generateAutopilotDecision = Effect.fn("Autopilot.generate")(function* () {
	const logger = yield* Logger;
	const scoped = yield* logger.namespace("Autopilot");
	yield* scoped.log("info", {
		message: "Autopilot: generation not wired — dependencies pending",
		status: "stub",
	});
	return;
});

export const Autopilot = define()({
	name: "Autopilot",
	signalHandlers: () => [],
	onProjectionsSettled: ({ publish, read }) =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			const scoped = yield* logger.namespace("Autopilot");
			if (isGenerating) {
				yield* scoped.log("debug", { message: "Autopilot: generation already in flight" });
				return;
			}
			// BLOCKED(parity): see file header — real generation logic is not wired (dependencies absent).
			yield* scoped.log("debug", { message: "Autopilot: settled — stub no-op" });
			void publish;
			void read;
			return;
		}).pipe(
			Effect.catchAllCause((cause) =>
				Effect.gen(function* () {
					const scoped = yield* (yield* Logger).namespace("Autopilot");
					yield* scoped.log("error", {
						message: "Autopilot: error in settled handler",
						cause: String(cause),
					});
				}),
			),
		),
});
