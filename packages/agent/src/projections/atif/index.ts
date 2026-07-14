// packages/agent/src/projections/atif/index.ts
//
// Public surface for the ATIF (Agent Trace Interchange Format) subsystem.

export { AtifAmbient, type AtifConfig } from "./ambient.ts";
export { type AtifForkState, AtifProjection, type AtifStep } from "./projection.ts";
export { type AtifDocument, type AtifSubagentTrajectory, type SerializeOptions, serializeAtif } from "./serialize.ts";
