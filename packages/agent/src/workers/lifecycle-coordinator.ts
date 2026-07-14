// packages/agent/src/workers/lifecycle-coordinator.ts
//
// LifecycleCoordinator drains the event sink and persists new events. It is a
// plain `worker.define()` (non-forked) that:
// - on `session_initialized`, forks a repeating `flushPendingEvents` effect on
// a 1500ms spaced schedule
// - on the `TurnProjection.signals.turnTerminated` signal, sleeps 100ms then
// flushes pending events
// - `flushPendingEvents` drains `EventSink`, persists each batch via
// `ChatPersistence.persistNewEvents`, and re-queues (prepend) any batch that
// fails after 3 exponential-backoff retries
//
// piki does not yet have a `ChatPersistence` service that backs durable event
// storage (that surface lives alongside the `ExecutionManager` migration in plan
// Section 3.3 Step 3). This file defines the `ChatPersistence` `Context.Tag`
// plus a no-op `Live` layer — matching the placeholder approach used by the
// sibling `AgentLifecycle` worker. The worker wiring (sink drain, retry,
// re-queue) is complete; only the persistence sink is a placeholder until
// `ChatPersistenceLive` lands.
//
// BLOCKED: no real ChatPersistence implementation exists yet
// (only ChatPersistenceNoop). Real durable event persistence requires a
// ChatPersistenceLive backed by piki session storage (JsonlRepo/MemoryRepo);
// intentional placeholder per a future milestone.

import { createSignal, defineWorker, EventSinkTag } from "@piki/event-core";
import { Logger } from "@piki/logger";
import { Context, Effect, Layer, Schedule } from "effect";

// ---------------------------------------------------------------------------
// ChatPersistence — dependency surface for LifecycleCoordinator
// ---------------------------------------------------------------------------

export interface ChatPersistenceShape {
	readonly persistNewEvents: (events: readonly unknown[]) => Effect.Effect<void>;
}

export const ChatPersistence = Context.GenericTag<ChatPersistenceShape>("piki/ChatPersistence");

export const ChatPersistenceNoop = Layer.succeed(ChatPersistence, {
	persistNewEvents: () => Effect.void,
});

// ---------------------------------------------------------------------------
// Business logic (wrapped with Effect.fn for tracing)
// ---------------------------------------------------------------------------

const flushPendingEvents = Effect.fn("LifecycleCoordinator.flushPendingEvents")(function* () {
	const eventSink = yield* EventSinkTag;
	const persistence = yield* ChatPersistence;
	const logger = yield* Logger;
	const scoped = yield* logger.namespace("LifecycleCoordinator");

	const pending = yield* eventSink.drainPending();
	if (pending.length === 0) return;

	yield* persistence.persistNewEvents(pending).pipe(
		Effect.retry({
			times: 3,
			schedule: Schedule.exponential("100 millis"),
		}),
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				yield* scoped.log("error", {
					context: "LifecycleCoordinator",
					error: String(error),
					pendingCount: pending.length,
				});
				yield* eventSink.prependEvents(pending);
			}),
		),
	);
});

// ---------------------------------------------------------------------------
// Worker definition (packages/agent/src/workers/lifecycle-coordinator.ts)
// ---------------------------------------------------------------------------

export const LifecycleCoordinator = defineWorker()({
	name: "LifecycleCoordinator",
	eventHandlers: {
		session_initialized: (_event, _publish) =>
			Effect.fork(Effect.repeat(flushPendingEvents(), Schedule.spaced("1500 millis"))).pipe(Effect.asVoid),
	},
	signalHandlers: (on) => [
		on(createSignal("Turn/turnTerminated", "Turn"), (_value, _publish) =>
			Effect.gen(function* () {
				yield* Effect.sleep("100 millis");
				yield* flushPendingEvents();
			}).pipe(Effect.asVoid),
		),
	],
});
