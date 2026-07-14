import { Cause, Context, Effect, Fiber, Layer, Queue, Ref, Stream } from "effect";
import { FrameworkError, FrameworkErrorReporter } from "../core/framework-error.ts";
import { HydrationContext } from "../core/hydration-context.ts";
import { InterruptCoordinator } from "../core/interrupt-coordinator.ts";
import { ProjectionBus } from "../core/projection-bus.ts";
import { WorkerBusTag } from "../core/worker-bus.ts";
import type { AnyProjection, WorkerReadFn } from "./define.ts";
import { extractForkIdFromEvent, extractForkIdFromSignal } from "./util.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventHandlerFn = (
	event: any,
	publish: (event: any) => Effect.Effect<void, unknown, unknown>,
	read: WorkerReadFn,
) => Effect.Effect<void, any, any>;

export type SignalHandlerFn = (
	value: any,
	publish: (event: any) => Effect.Effect<void, unknown, unknown>,
	read: WorkerReadFn,
) => Effect.Effect<void, any, any>;

export interface SignalHandlerPair {
	readonly signal: { name: string; tag: Context.Tag<any, any> };
	readonly handler: SignalHandlerFn;
}

export interface ForkedWorkerConfig {
	readonly name: string;
	readonly eventHandlers?: Record<string, EventHandlerFn>;
	readonly forkLifecycle: {
		readonly activateOn: string | readonly string[];
		readonly completeOn: string | readonly string[];
	};
	readonly signalHandlers?: (
		on: (signal: { name: string; tag: Context.Tag<any, any> }, handler: SignalHandlerFn) => SignalHandlerPair,
	) => readonly SignalHandlerPair[];
	readonly ignoreInterrupt?: readonly string[];
}

interface ForkFiberEntry {
	readonly fiber: Fiber.Fiber<void, unknown>;
	readonly queue: Queue.Queue<any>;
}

// ---------------------------------------------------------------------------
// Service shape & definition
// ---------------------------------------------------------------------------

export interface ForkedWorkerShape {
	readonly processEvent: (event: any) => Effect.Effect<void, any, any>;
	readonly processSignal: (signal: any) => Effect.Effect<void, any, any>;
	readonly activeForkIds: Effect.Effect<readonly string[], any, any>;
}

export interface ForkedWorkerDefinition {
	readonly Tag: Context.Tag<any, any>;
	readonly Layer: Layer.Layer<any, any, any>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toArray(value: string | readonly string[]): readonly string[] {
	return typeof value === "string" ? [value] : value;
}

function makeWorkerReadFn(
	projectionBus: {
		getProjectionState: (name: string) => unknown;
		getForkState: (name: string, forkId: string | null) => unknown;
	},
	forkId: string | null,
	allowedReadNames: Set<string>,
	forkedReadNames: Set<string>,
): WorkerReadFn {
	const impl = (projection: AnyProjection, overrideForkId?: string | null): Effect.Effect<any, any, any> => {
		const targetForkId = overrideForkId !== undefined ? overrideForkId : forkId;
		const name = projection.name;
		if (!allowedReadNames.has(name)) {
			return Effect.die(new Error(`Worker read of "${name}" not declared`));
		}
		if (projection.isForked || forkedReadNames.has(name)) {
			return Effect.sync(() => projectionBus.getForkState(name, targetForkId));
		}
		return Effect.sync(() => projectionBus.getProjectionState(name));
	};
	impl.allForks = (projection: AnyProjection) => {
		if (!allowedReadNames.has(projection.name)) {
			return Effect.die(new Error(`Worker read of "${projection.name}" not declared`));
		}
		return Effect.sync(() => projectionBus.getProjectionState(projection.name));
	};
	return impl as WorkerReadFn;
}

// ---------------------------------------------------------------------------
// defineForked
// ---------------------------------------------------------------------------

export function defineForked(config: ForkedWorkerConfig): ForkedWorkerDefinition {
	const serviceName = `${config.name}ForkedWorker`;
	const Tag = Context.GenericTag<any>(serviceName);

	const handlerEventTypes = config.eventHandlers ? new Set(Object.keys(config.eventHandlers)) : new Set<string>();
	const activateOnTypes = toArray(config.forkLifecycle.activateOn);
	const completeOnTypes = toArray(config.forkLifecycle.completeOn);
	const activateOnSet = new Set(activateOnTypes);
	const completeOnSet = new Set(completeOnTypes);
	const _ignoreInterrupt = new Set(config.ignoreInterrupt ?? []);

	const Live = Layer.scoped(
		Tag,
		Effect.gen(function* () {
			const bus = yield* WorkerBusTag;
			const projectionBus = yield* ProjectionBus;
			const hydration = yield* HydrationContext;
			const _interruptCoordinator = yield* InterruptCoordinator;
			const reporter = yield* FrameworkErrorReporter;

			if (yield* hydration.isHydrating()) return;

			const publish = (event: any) => bus.publish(event);

			const forkFibers = yield* Ref.make(new Map<string, ForkFiberEntry>());

			const spawnForkFiber = (forkId: string): Effect.Effect<void, any, any> =>
				Effect.gen(function* () {
					const queue = yield* Queue.unbounded<any>();
					const fiber = yield* Effect.forkScoped(
						Stream.runForEach(Stream.fromQueue(queue), (event: any) => {
							const handler = config.eventHandlers?.[event.type];
							if (!handler) return Effect.void;
							const read = makeWorkerReadFn(projectionBus, forkId, new Set(), new Set());
							return handler(event, publish, read).pipe(
								Effect.catchAllCause((cause) => {
									if ((Cause as any).isInterruptedOnly?.(cause)) return Effect.void;
									return Effect.logError(
										`ForkedWorker[${config.name}] handler error for ${event.type}`,
										cause,
									);
								}),
							);
						}),
					);
					yield* Ref.update(forkFibers, (m) => new Map(m).set(forkId, { fiber, queue }));
				});

			// Always spawn the main fork.
			yield* spawnForkFiber("__main__");

			// Subscribe to event bus for routed events.
			const allEventTypes = new Set<string>([...activateOnTypes, ...completeOnTypes, ...handlerEventTypes]);
			if (allEventTypes.size > 0) {
				yield* Effect.forkScoped(
					Stream.runForEach(bus.subscribeToTypes([...allEventTypes]), (event: any) =>
						Effect.gen(function* () {
							const forkId = extractForkIdFromEvent(event) ?? "__main__";

							// activateOn: spawn fork if missing
							if (activateOnSet.has(event.type) && forkId !== "__main__") {
								const existing = yield* Ref.get(forkFibers);
								if (!existing.has(forkId)) {
									yield* spawnForkFiber(forkId);
								}
							}

							// completeOn: interrupt and remove fork
							if (completeOnSet.has(event.type) && forkId !== "__main__") {
								const fibers = yield* Ref.get(forkFibers);
								const entry = fibers.get(forkId);
								if (entry) {
									yield* Fiber.interrupt(entry.fiber);
									yield* Ref.update(forkFibers, (m) => {
										const next = new Map(m);
										next.delete(forkId);
										return next;
									});
								}
							}

							// Handler events: enqueue to fork's queue
							if (handlerEventTypes.has(event.type)) {
								const fibers = yield* Ref.get(forkFibers);
								const entry = fibers.get(forkId);
								if (entry) {
									yield* Queue.offer(entry.queue, event);
								}
							}
						}).pipe(
							Effect.catchAllCause((cause) =>
								reporter.report(
									FrameworkError.WorkerEventHandlerError({
										workerName: config.name,
										eventType: event.type,
										cause,
									}),
								),
							),
						),
					),
				);
			}

			// Signal handlers: subscribe to PubSub per signal.
			if (config.signalHandlers) {
				const on = (signal: { name: string; tag: Context.Tag<any, any> }, handler: SignalHandlerFn) => ({
					signal,
					handler,
				});
				const handlerPairs = config.signalHandlers(on as any);
				for (const { signal, handler } of handlerPairs) {
					const pubsub = yield* signal.tag;
					yield* Effect.forkScoped(
						Stream.runForEach(Stream.fromPubSub(pubsub), (value: any) =>
							Effect.gen(function* () {
								if (yield* hydration.isHydrating()) return;
								const signalForkId = extractForkIdFromSignal(value);
								const read = makeWorkerReadFn(projectionBus, signalForkId, new Set(), new Set());
								yield* handler(value, publish, read);
							}).pipe(
								Effect.catchAllCause((cause) =>
									reporter.report(
										FrameworkError.WorkerSignalHandlerError({
											workerName: config.name,
											signalName: signal.name,
											cause,
										}),
									),
								),
							),
						),
					);
				}
			}

			return {
				processEvent: (event: any) =>
					Effect.gen(function* () {
						const forkId = extractForkIdFromEvent(event) ?? "__main__";
						if (activateOnSet.has(event.type) && forkId !== "__main__") {
							const existing = yield* Ref.get(forkFibers);
							if (!existing.has(forkId)) {
								yield* spawnForkFiber(forkId);
							}
						}
						if (completeOnSet.has(event.type) && forkId !== "__main__") {
							const fibers = yield* Ref.get(forkFibers);
							const entry = fibers.get(forkId);
							if (entry) {
								yield* Fiber.interrupt(entry.fiber);
								yield* Ref.update(forkFibers, (m) => {
									const next = new Map(m);
									next.delete(forkId);
									return next;
								});
							}
						}
						if (handlerEventTypes.has(event.type)) {
							const fibers = yield* Ref.get(forkFibers);
							const entry = fibers.get(forkId);
							if (entry) {
								yield* Queue.offer(entry.queue, event);
							}
						}
					}),
				processSignal: (_signal: any) => Effect.void,
				activeForkIds: Ref.get(forkFibers).pipe(Effect.map((m) => [...m.keys()])),
			} satisfies ForkedWorkerShape;
		}),
	);

	return { Tag, Layer: Live };
}
