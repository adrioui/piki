// packages/agent/src/projections/compaction-config.ts
//
// CompactionConfigAmbient delivers the compaction soft token cap to the
// CompactionWorker. It is registered into the event-core AmbientService by
// being attached to a projection's `ambients` array (see atif/projection.ts),
// and populated upstream by the coding-agent assembly via
// `AmbientServiceTag.update(CompactionConfigAmbient, { softCap })`. This keeps
// agent-core independent of coding-agent: the worker reads the value through
// `AmbientServiceTag` and never imports role-config code.

import { type AmbDef, defineAmbient } from "@piki/event-core";

/** Configuration consumed by the compaction subsystem. */
export interface CompactionConfig {
	/** Soft token cap; 0 disables compaction sizing. */
	readonly softCap: number;
}

export const CompactionConfigAmbient: AmbDef<CompactionConfig> = defineAmbient<CompactionConfig>({
	name: "CompactionConfig",
	initial: { softCap: 0 },
});
