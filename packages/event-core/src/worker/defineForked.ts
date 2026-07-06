// packages/event-core/src/worker/defineForked.ts
// defineForked — per-fork fiber lifecycle manager adapted from Magnitude.
//
// Each fork gets a Fiber backed by a Queue. Events are routed:
//   activateOn  → spawn fork fiber (if missing)
//   completeOn  → interrupt and remove fork fiber
//   handler     → enqueue into the fork's queue
// Signal handlers resolve forkId from the signal payload and receive a
// fork-scoped `read` function.

import { Context, Effect, Fiber, Layer, Queue, Ref, Stream } from "effect";
import type { EventEnvelope, Signal } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractForkId(event: EventEnvelope): string | null {
	const payload = event.payload as Record<string, unknown> | null;
	if (!payload) return null;
	const id = payload.forkId ?? payload.workerId;
	return typeof id === "string" ? id : null;
}

function toArray(value: string | readonly string[]): readonly string[] {
	return typeof value === "string" ? [value] : value;
}

function makeReadFn(): ForkReadFn {
	return (_projectionName: string, _overrideForkId?: string) => undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventHandlerFn = (
	event: EventEnvelope,
	publish: (event: EventEnvelope) => Effect.Effect<void>,
	read: ForkReadFn,
) => Effect.Effect<void>;

export type SignalHandlerFn = (
	value: unknown,
	publish: (event: EventEnvelope) => Effect.Effect<void>,
	read: ForkReadFn,
) => Effect.Effect<void>;

/**
 * Read function scoped to a specific fork. Call with a projection name to
 * read its state. Pass `overrideForkId` to read from a different fork.
 */
export type ForkReadFn = (projectionName: string, overrideForkId?: string) => unknown;

export interface SignalHandlerPair {
	readonly signal: string;
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
		on: (signal: string, handler: SignalHandlerFn) => SignalHandlerPair,
	) => readonly SignalHandlerPair[];
	/** Optional no-op publish for handlers that need to emit events. */
	readonly publish?: (event: EventEnvelope) => Effect.Effect<void>;
}

interface ForkFiberEntry {
	readonly fiber: Fiber.Fiber<void, unknown>;
	readonly queue: Queue.Queue<EventEnvelope>;
}

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

export interface ForkedWorkerShape {
	/** Route an incoming event to the correct fork's lifecycle or queue. */
	readonly processEvent: (event: EventEnvelope) => Effect.Effect<void>;
	/** Route an incoming signal to the resolved fork's signal handler. */
	readonly processSignal: (signal: Signal) => Effect.Effect<void>;
	/** Snapshot of currently active fork IDs. */
	readonly activeForkIds: Effect.Effect<readonly string[]>;
}

// ---------------------------------------------------------------------------
// defineForked
// ---------------------------------------------------------------------------

export function defineForked(config: ForkedWorkerConfig) {
	const serviceName = `${config.name}ForkedWorker`;
	const Tag = Context.Service<ForkedWorkerShape>(serviceName);

	const handlerEventTypes = config.eventHandlers ? new Set(Object.keys(config.eventHandlers)) : new Set<string>();
	const activateOnTypes = toArray(config.forkLifecycle.activateOn);
	const completeOnTypes = toArray(config.forkLifecycle.completeOn);
	const activateOnSet = new Set(activateOnTypes);
	const completeOnSet = new Set(completeOnTypes);

	const defaultPublish = config.publish ?? ((_event: EventEnvelope) => Effect.void);

	const Live = Layer.effect(
		Tag,
		Effect.gen(function* () {
			const forkFibers = yield* Ref.make(new Map<string, ForkFiberEntry>());

			// Spawn a fork fiber backed by an unbounded queue.
			// Uses Effect.runFork since Layer.scoped is unavailable in effect@4.0.0-beta.93.
			const spawnForkFiber = (forkId: string): Effect.Effect<void> =>
				Effect.sync(() => {
					const queue = Effect.runSync(Queue.unbounded<EventEnvelope>());
					const fiber = Effect.runFork(
						Stream.runForEach(Stream.fromQueue(queue), (event) => {
							const handler = config.eventHandlers?.[event.type];
							if (!handler) return Effect.void;
							const read = makeReadFn();
							return handler(event, defaultPublish, read).pipe(
								Effect.catchCause((cause) =>
									Effect.logError(`ForkedWorker[${config.name}] handler error for ${event.type}`, cause),
								),
							);
						}),
					);
					Effect.runSync(Ref.update(forkFibers, (m) => new Map(m).set(forkId, { fiber, queue })));
				});

			// Always spawn the null (leader) fork.
			yield* spawnForkFiber("__main__");

			return {
				processEvent: (event: EventEnvelope) =>
					Effect.gen(function* () {
						const forkId = extractForkId(event) ?? "__main__";

						// activateOn: spawn fork if missing
						if (activateOnSet.has(event.type)) {
							if (forkId !== "__main__") {
								const existing = yield* Ref.get(forkFibers);
								if (!existing.has(forkId)) {
									yield* spawnForkFiber(forkId);
								}
							}
						}

						// completeOn: interrupt and remove fork
						if (completeOnSet.has(event.type)) {
							if (forkId !== "__main__") {
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
						}

						// Handler events: enqueue to fork's queue
						if (handlerEventTypes.has(event.type)) {
							const fibers = yield* Ref.get(forkFibers);
							const entry = fibers.get(forkId);
							if (entry) {
								yield* Queue.offer(entry.queue, event);
							}
						}
					}),

				processSignal: (signal: Signal) =>
					Effect.gen(function* () {
						const pairs = config.signalHandlers
							? config.signalHandlers((s, h) => ({ signal: s, handler: h }))
							: [];
						for (const pair of pairs) {
							if (pair.signal !== signal.type) continue;
							const read = makeReadFn();
							yield* pair
								.handler(signal.payload, defaultPublish, read)
								.pipe(
									Effect.catchCause((cause) =>
										Effect.logError(
											`ForkedWorker[${config.name}] signal handler error for ${signal.type}`,
											cause,
										),
									),
								);
						}
					}),

				activeForkIds: Ref.get(forkFibers).pipe(Effect.map((m) => [...m.keys()])),
			} satisfies ForkedWorkerShape;
		}),
	);

	return { Tag, Live };
}
