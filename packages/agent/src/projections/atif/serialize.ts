// packages/agent/src/projections/atif/serialize.ts
//
// serializeAtif turns the per-fork ATIF step lists into a single ATIF-v1.7
// document. The document is the on-disk/interchange shape persisted by
// AtifWriter; this module owns only the structural mapping.

import type { AtifForkState, AtifStep } from "./projection.ts";

export interface SerializeOptions {
	/** When true, only the root fork's steps are included in `steps`. */
	readonly solo: boolean;
	/** Optional stable id for the trajectory; falls back to "unknown". */
	readonly trajectoryId?: string;
}

export interface AtifSubagentTrajectory {
	readonly forkId: string;
	readonly steps: ReadonlyArray<AtifStep>;
}

export interface AtifDocument {
	readonly schema_version: "ATIF-v1.7";
	readonly trajectory_id: string;
	readonly agent: { readonly name: string; readonly version: string };
	readonly steps: ReadonlyArray<AtifStep>;
	readonly final_metrics: null;
	readonly subagent_trajectories: ReadonlyArray<AtifSubagentTrajectory>;
}

/**
 * Serialize the recorded ATIF forks into a single document.
 *
 * `steps` is the root fork (forkId null) when `solo` is true, otherwise the
 * root fork followed by every subagent fork in insertion order.
 * `subagent_trajectories` always lists the non-root forks individually.
 */
export function serializeAtif(
	forks: ReadonlyMap<string | null, AtifForkState>,
	options: SerializeOptions,
): AtifDocument {
	const root = forks.get(null);
	const subagents: Array<AtifSubagentTrajectory> = [];
	for (const [forkId, state] of forks) {
		if (forkId === null) continue;
		subagents.push({ forkId: String(forkId), steps: state.steps });
	}

	const steps: Array<AtifStep> = [];
	if (root) steps.push(...root.steps);
	if (!options.solo) {
		for (const sub of subagents) steps.push(...sub.steps);
	}

	return {
		schema_version: "ATIF-v1.7",
		trajectory_id: options.trajectoryId ?? "unknown",
		agent: { name: "piki", version: "1.0.0" },
		steps,
		final_metrics: null,
		subagent_trajectories: subagents,
	};
}
