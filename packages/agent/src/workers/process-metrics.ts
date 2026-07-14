// ProcessMetrics worker — periodic shell process metric sampling.
//
// The worker:
//   - starts a 5s recurring sampler once projections have settled
//   - reads running detached processes from DetachedProcessProjection
//   - walks the process tree via `ps`, sums cpu% / rss for each root pid
//   - publishes `shell_process_metrics` events consumed by the projection
//
// Branding kept as "piki" in user-facing log strings.

import { defineWorker } from "@piki/event-core";
import { Logger } from "@piki/logger";
import { Cause, Effect, Schedule } from "effect";
import { sampleMetrics } from "../process/ps-tree.ts";
import { DetachedProcessProjection, type DetachedProcessState } from "../projections/detached-process.ts";

const SAMPLE_INTERVAL = "5 seconds";

let samplerStarted = false;

function sampleAndPublish(publish: (event: unknown) => any, read: any) {
	return Effect.gen(function* () {
		const forkedState = yield* read.allForks(DetachedProcessProjection);
		const runningPids: number[] = [];
		for (const [, fork] of forkedState as Map<string | null, DetachedProcessState>) {
			for (const [pid, proc] of fork.processes) {
				if (proc.status === "running") {
					runningPids.push(pid);
				}
			}
		}
		if (runningPids.length === 0) {
			return;
		}
		const samples = yield* sampleMetrics(runningPids);
		if (samples.length === 0) {
			return;
		}
		yield* publish({
			type: "shell_process_metrics",
			forkId: null,
			samples,
		});
	}).pipe(
		Effect.catchAllCause((cause) =>
			Effect.gen(function* () {
				const logger = yield* Logger;
				const scoped = yield* logger.namespace("ProcessMetricsWorker");
				yield* scoped.log("warn", {
					cause: Cause.pretty(cause),
					message: "[ProcessMetricsWorker] Sample cycle failed, skipping",
				});
			}),
		),
	);
}

export const ProcessMetrics = defineWorker()({
	name: "ProcessMetrics",
	onProjectionsSettled: ({ publish, read }) =>
		Effect.gen(function* () {
			if (samplerStarted) return;
			samplerStarted = true;
			yield* Effect.fork(Effect.repeat(sampleAndPublish(publish, read), Schedule.spaced(SAMPLE_INTERVAL)));
		}),
});
