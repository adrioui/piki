import { Context, Deferred, Effect, Layer, PubSub, Queue, Stream } from "effect";
import { extractForkIdFromEvent } from "../worker/util.ts";
import { EventSinkTag } from "./event-sink.ts";
import { FrameworkError, FrameworkErrorReporter } from "./framework-error.ts";
import { HydrationContext } from "./hydration-context.ts";
import { InterruptCoordinator } from "./interrupt-coordinator.ts";
import { ProjectionBus } from "./projection-bus.ts";

export interface EventBusCoreShape {
	readonly publish: (event: any) => Effect.Effect<void, any, any>;
	readonly subscribeToTypes: (types: readonly string[]) => Stream.Stream<any, any, any>;
	readonly stream: Stream.Stream<any, any, any>;
	readonly subscribe: () => Effect.Effect<Stream.Stream<any, any, any>, any, any>;
}

export const EventBusCoreTag = Context.GenericTag<EventBusCoreShape>("@piki/EventBusCore");

export function makeEventBusCoreLayer() {
	return Layer.scoped(
		EventBusCoreTag,
		Effect.gen(function* () {
			const hydration = yield* HydrationContext;
			const sink = yield* EventSinkTag;
			const interruptCoordinator = yield* InterruptCoordinator;
			const projectionBus = yield* ProjectionBus;
			const reporter = yield* FrameworkErrorReporter;
			const pubsub = yield* PubSub.unbounded<any>();
			yield* interruptCoordinator.beginExecution(null);
			const eventQueue = yield* Queue.unbounded<{ event: any; done: Deferred.Deferred<void> }>();

			yield* Effect.forkScoped(
				Effect.forever(
					Effect.gen(function* () {
						const { event, done } = yield* Queue.take(eventQueue);
						yield* Effect.gen(function* () {
							yield* projectionBus.processEvent(event);
							if (yield* hydration.isHydrating()) return;
							if (event.type === "interrupt") {
								yield* interruptCoordinator.interrupt(extractForkIdFromEvent(event));
							}
							if (!event.ephemeral) {
								yield* sink
									.append(event)
									.pipe(
										Effect.catchAllCause((cause) =>
											reporter.report(FrameworkError.SinkError({ eventType: event.type, cause })),
										),
									);
							}
							yield* PubSub.publish(pubsub, event).pipe(
								Effect.catchAllCause((cause) =>
									reporter.report(FrameworkError.BroadcastError({ eventType: event.type, cause })),
								),
							);
						}).pipe(
							Effect.matchCauseEffect({
								onFailure: (cause) =>
									Effect.logError(`[EventBus] Critical failure for: ${event.type}`, cause).pipe(
										Effect.andThen(Deferred.failCause(done, cause)),
									),
								onSuccess: () => Deferred.succeed(done, undefined),
							}),
						);
					}),
				),
			);

			return {
				publish: (event) =>
					Effect.gen(function* () {
						const timestamp =
							"timestamp" in event && typeof event.timestamp === "number" ? event.timestamp : Date.now();
						const timestamped = { ...event, timestamp };
						const done = yield* Deferred.make<void>();
						yield* Queue.offer(eventQueue, { event: timestamped, done });
						yield* Deferred.await(done).pipe(Effect.catchAllCause((cause) => Effect.failCause(cause)));
					}),
				subscribeToTypes: (types) =>
					Stream.fromPubSub(pubsub).pipe(Stream.filter((e: any) => types.some((t) => t === e.type))),
				stream: Stream.fromPubSub(pubsub),
				subscribe: () => Effect.map(PubSub.subscribe(pubsub), (queue) => Stream.fromQueue(queue as never)),
			};
		}),
	);
}
