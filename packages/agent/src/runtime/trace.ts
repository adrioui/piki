// packages/agent/src/runtime/trace.ts
import { Context, Effect, Layer } from "effect";

/**
 * A trace event. Thin wrapper around an EventEnvelope — carries the
 * fields a trace listener cares about without persistence metadata.
 */
export interface TraceEvent {
	readonly type: string;
	readonly timestamp: string;
	readonly sessionId?: string;
	readonly forkId?: string;
	readonly payload: Record<string, unknown>;
}

/** Adapts an EventEnvelope (event-core) to a TraceEvent. */
export function traceEventFromEnvelope(env: {
	type: string;
	timestamp: string;
	sessionId?: string;
	payload: unknown;
}): TraceEvent {
	return {
		type: env.type,
		timestamp: env.timestamp,
		sessionId: env.sessionId,
		payload: (env.payload ?? {}) as Record<string, unknown>,
	};
}

/** A trace listener — receives every trace event. Must not throw. */
export interface TraceShape {
	readonly onEvent: (event: TraceEvent) => Effect.Effect<void>;
}

export const Trace = Context.GenericTag<TraceShape>("Trace");

/** No-op layer — default when no listeners registered. Never fails. */
export const TraceNoop = Layer.succeed(Trace, {
	onEvent: (_event: TraceEvent) => Effect.void,
});
