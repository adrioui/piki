// packages/event-core/src/runtime/trace-bus.ts
import { Context, Effect, Layer, PubSub, type Queue, type Scope } from "effect";

/**
 * TraceEvent shape — re-declared here to avoid a cross-package type import
 * cycle. Kept structurally identical to packages/agent/src/runtime/trace.ts.
 */
export interface TraceEvent {
	readonly type: string;
	readonly timestamp: string;
	readonly sessionId?: string;
	readonly forkId?: string;
	readonly payload: Record<string, unknown>;
}

export interface TraceBusShape {
	/** Emit a trace event to all subscribers. Never fails — subscriber errors are swallowed. */
	readonly emit: (event: TraceEvent) => Effect.Effect<void>;
	/** Subscribe to the full stream of trace events. */
	readonly subscribe: () => Effect.Effect<Queue.Dequeue<TraceEvent>, never, Scope.Scope>;
}

export const TraceBus = Context.GenericTag<TraceBusShape>("TraceBus");

/**
 * Live TraceBus layer. Builds an unbounded PubSub.
 * Publish failures are swallowed — trace must never break the caller.
 */
export const TraceBusLive = Layer.effect(
	TraceBus,
	Effect.gen(function* () {
		const pubsub = yield* PubSub.unbounded<TraceEvent>();
		return {
			emit: (event: TraceEvent) =>
				PubSub.publish(pubsub, event).pipe(
					Effect.catchAllCause(() => Effect.void),
					Effect.asVoid,
				),
			subscribe: () => PubSub.subscribe(pubsub),
		};
	}),
);
