// pi already covers this; no projection port required.
// Use `createTurnProjection()` (builtin-extended.ts:233-258) —
// its `TurnState.status: "idle"|"running"|"finished"` is the event-sourced
// harness-status snapshot, and `AgentHarnessPhase` (harness/types.ts:492) is
// the imperative guard. Register the Turn projection (already in
// createBuiltinExtendedProjections()).
export {};
