import { Context, Effect, Layer, Ref } from "effect";

export interface EventSinkShape {
	readonly append: (event: unknown) => Effect.Effect<void>;
	readonly readPending: () => Effect.Effect<readonly unknown[]>;
	readonly drainPending: () => Effect.Effect<readonly unknown[]>;
	readonly prependEvents: (events: readonly unknown[]) => Effect.Effect<void>;
}

export const EventSinkTag = Context.GenericTag<EventSinkShape>("@piki/EventSink");

export function makeEventSinkLayer() {
	return Layer.scoped(
		EventSinkTag,
		Effect.gen(function* () {
			const pendingRef = yield* Ref.make<unknown[]>([]);
			return {
				append: (event) => Ref.update(pendingRef, (events) => [...events, event]),
				readPending: () => Ref.get(pendingRef),
				drainPending: () => Ref.getAndSet(pendingRef, []),
				prependEvents: (events) => Ref.update(pendingRef, (pending) => [...events, ...pending]),
			};
		}),
	);
}
