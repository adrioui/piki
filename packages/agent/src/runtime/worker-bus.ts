// packages/agent/src/runtime/worker-bus.ts
import type { EventEnvelope } from "@piki/event-core";
import { Context, Effect, Layer, PubSub, type Scope, Stream } from "effect";

/** Event types carried by the worker bus. */
export type WorkerBusEventType =
	| "agent_created"
	| "agent_finished"
	| "worker_messaged"
	| "worker_killed"
	| "fork_created"
	| "fork_cleaned";

export type WorkerBusEvent = EventEnvelope<string, Record<string, unknown>>;

export interface WorkerBusShape {
	/** Publish a worker lifecycle event to the bus AND delegate to the underlying sink. */
	readonly publish: (event: WorkerBusEvent) => Effect.Effect<void, unknown>;
	/** Full unfiltered stream of all bus events (new subscription per run). */
	readonly stream: Stream.Stream<WorkerBusEvent>;
	/** Subscribe to all events. Scoped — subscription auto-closes on scope exit. */
	readonly subscribe: () => Effect.Effect<Stream.Stream<WorkerBusEvent>, unknown, Scope.Scope>;
	/** Subscribe to a stream filtered by event type. Scoped. */
	readonly subscribeToTypes: (
		types: readonly WorkerBusEventType[],
	) => Effect.Effect<Stream.Stream<WorkerBusEvent>, unknown, Scope.Scope>;
}

export const WorkerBus = Context.GenericTag<WorkerBusShape>("WorkerBus");

/**
 * Live layer factory. Takes a `publishFn` (typically EventSink.publish) and
 * builds an internal PubSub for filtered subscribers.
 *
 * Uses `Layer.effect` (NOT `Layer.scoped` — absent in `effect@4.0.0-beta.93`).
 * `PubSub.unbounded<A>` in this beta returns `Effect<PubSub, never, never>`,
 * so no Scope is required in the layer's environment.
 *
 * `subscribe()` / `subscribeToTypes()` use `PubSub.subscribe` (eager) +
 * `Stream.fromQueue` so that events published AFTER subscribing are
 * captured — `Stream.fromPubSub` is eager too but subscribe gives the caller
 * a dedicated queue with scoped lifetime.
 */
export function makeWorkerBusLayer(
	publishFn: (event: WorkerBusEvent) => Promise<void>,
): Layer.Layer<WorkerBusShape, never, never> {
	return Layer.effect(
		WorkerBus,
		Effect.gen(function* () {
			const pubsub = yield* PubSub.unbounded<WorkerBusEvent>();
			return {
				publish: (event: WorkerBusEvent) =>
					Effect.gen(function* () {
						yield* PubSub.publish(pubsub, event);
						yield* Effect.tryPromise({
							try: () => publishFn(event),
							catch: (error: unknown) => error,
						});
					}).pipe(Effect.asVoid),
				stream: Stream.fromPubSub(pubsub),
				subscribe: () => Effect.map(PubSub.subscribe(pubsub), Stream.fromQueue),
				subscribeToTypes: (types: readonly WorkerBusEventType[]) =>
					Effect.map(PubSub.subscribe(pubsub), (queue) =>
						Stream.fromQueue(queue).pipe(
							Stream.filter((event) => types.includes(event.type as WorkerBusEventType)),
						),
					),
			};
		}),
	);
}
