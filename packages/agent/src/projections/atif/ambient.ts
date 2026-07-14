// packages/agent/src/projections/atif/ambient.ts
//
// AtifAmbient is the configuration surface for the ATIF (Agent Trace
// Interchange Format) subsystem. The projection records the trajectory
// regardless of whether persistence is enabled; this ambient only controls
// whether steps are emitted/surfaced and where the serialized document is
// written by AtifWriter.

import { type AmbDef, defineAmbient } from "@piki/event-core";

/** Configuration for the ATIF subsystem. */
export interface AtifConfig {
	/** When false, the projection does not record steps. */
	readonly enabled: boolean;
	/** When true, AtifWriter persists the serialized document to disk. */
	readonly writeFile: boolean;
	/** Target path for the ATIF document; null falls back to the results dir. */
	readonly filePath: string | null;
	/** When true, AtifWriter serializes all forks; otherwise root-only. */
	readonly streamSteps: boolean;
	/** Optional per-step append path; null disables incremental streaming. */
	readonly stepsPath: string | null;
}

export const AtifAmbient: AmbDef<AtifConfig> = defineAmbient<AtifConfig>({
	name: "Atif",
	initial: {
		enabled: false,
		writeFile: false,
		filePath: null,
		streamSteps: false,
		stepsPath: null,
	},
});
