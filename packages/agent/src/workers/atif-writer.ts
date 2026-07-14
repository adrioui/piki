// packages/agent/src/workers/atif-writer.ts
//
// AtifWriter persists the Agent Trace Interchange Format (ATIF) trajectory to
// disk. It subscribes to the `AtifProjection` `stepAdded` signal and, on every
// recorded step, re-serializes the full set of ATIF forks and writes the
// resulting ATIF-v1.7 document atomically to the configured path.
//
// Persistence is gated by the AtifAmbient config: when `writeFile` is false the
// worker is a no-op. The target path comes from `AtifAmbient.filePath`; when
// unset, the document falls back to the scratchpad results directory.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AmbientServiceTag, defineWorker, type WorkerDefinition } from "@piki/event-core";
import { Logger } from "@piki/logger";
import { Cause, Effect } from "effect";
import { AtifAmbient, type AtifConfig } from "../projections/atif/ambient.ts";
import { type AtifForkState, AtifProjection } from "../projections/atif/projection.ts";
import { serializeAtif } from "../projections/atif/serialize.ts";

/**
 * Resolve the scratchpad results directory from the `M` env var.
 * Falls back to a local `.piki-results` dir when `M` is unset so the worker
 * never throws on an unconfigured environment.
 */
function resolveResultsDir(): string {
	const m = process.env.M;
	const base = m && m.length > 0 ? join(m, "results") : join(process.cwd(), ".piki-results");
	return base;
}

/**
 * Read all ATIF fork states. `read.allForks` returns an untyped fork map; the
 * cast is localized here because the projection is the source of truth for the
 * ATIF fork state shape.
 */
function readAtifForks(read: unknown): Effect.Effect<ReadonlyMap<string | null, AtifForkState>> {
	const readFn = read as {
		allForks: (projection: unknown) => Effect.Effect<Map<string | null, AtifForkState>>;
	};
	return readFn.allForks(AtifProjection);
}

const writeTrajectory = Effect.fn("AtifWriter.writeTrajectory")(function* (
	_value: unknown,
	_publish: unknown,
	read: unknown,
) {
	const logger = yield* Logger;
	const scoped = yield* logger.namespace("AtifWriter");

	const ambientService = yield* AmbientServiceTag;
	// `getValue` cannot infer the ambient's type parameter through the
	// cross-module `AmbDef`/`AmbientDef` boundary, so the cast is localized.
	const cfg = ambientService.getValue(AtifAmbient) as AtifConfig;
	if (!cfg.writeFile) return;

	const forks = yield* readAtifForks(read);
	const doc = serializeAtif(forks, { solo: !cfg.streamSteps });

	const filePath = cfg.filePath ?? join(resolveResultsDir(), "trajectory.atif.json");
	const tmpPath = `${filePath}.tmp`;
	yield* Effect.promise(() => mkdir(dirname(filePath), { recursive: true }));
	yield* Effect.promise(() => writeFile(tmpPath, JSON.stringify(doc, null, 2), "utf-8"));
	yield* Effect.promise(() => rename(tmpPath, filePath));

	yield* scoped.log("debug", {
		message: "AtifWriter: trajectory written",
		filePath,
		stepCount: doc.steps.length,
	});
});

export const AtifWriter: WorkerDefinition = defineWorker()({
	name: "AtifWriter",
	signalHandlers: (on) => [
		on(AtifProjection.signals.stepAdded, (value, publish, read) =>
			writeTrajectory(value, publish, read).pipe(
				Effect.catchAllCause((cause) =>
					Effect.gen(function* () {
						const logger = yield* Logger;
						const scoped = yield* logger.namespace("AtifWriter");
						yield* scoped.log("error", {
							message: "AtifWriter: write failed",
							cause: Cause.pretty(cause),
						});
					}),
				),
			),
		),
	],
});
