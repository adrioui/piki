// packages/agent/src/workers/compaction/turn-runner.ts
//
// CompactionTurnRunner is the agent-core service boundary that executes a
// compaction turn. agent-core ships a Noop fallback (the Noop returns a typed
// error so the worker publishes `compaction_failed` instead of crashing the
// fork). The real live runner — wrapping the session's model turn executor — is
// wired by the coding-agent assembly and is intentionally out of scope here.

import { Context, Data, Effect, Layer } from "effect";

/** Error returned when a compaction turn cannot be executed. */
export class CompactionError extends Data.TaggedError("CompactionError")<{
	readonly reason: string;
	readonly cause?: unknown;
}> {}

/** Result of a successful compaction turn. */
export interface CompactionTurnResult {
	readonly turn: unknown;
	readonly compactionOutcome: unknown;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

/** Shape of the compaction turn runner service. */
export interface CompactionTurnRunnerShape {
	readonly run: (args: {
		readonly forkId: string | null;
		readonly roleId: string;
		readonly windowMessages: ReadonlyArray<unknown>;
		readonly softCap: number;
		readonly compactedMessageCount: number;
	}) => Effect.Effect<CompactionTurnResult, CompactionError>;
}

export const CompactionTurnRunner = Context.GenericTag<CompactionTurnRunnerShape>("piki/CompactionTurnRunner");

// Noop fallback so agent-core typechecks and tests pass without coding-agent
// wiring. It MUST NOT throw: it returns a typed error channel value so the
// worker can publish `compaction_failed` rather than crashing the fork.
export const CompactionTurnRunnerNoop = Layer.succeed(CompactionTurnRunner, {
	run: () => Effect.fail(new CompactionError({ reason: "compaction turn runner not configured" })),
});
