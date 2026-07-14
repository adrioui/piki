import { Context, Effect, Layer, Ref } from "effect";

export interface HydrationContextShape {
	readonly isHydrating: () => Effect.Effect<boolean>;
	readonly setHydrating: (value: boolean) => Effect.Effect<void>;
}

export const HydrationContext = Context.GenericTag<HydrationContextShape>("@piki/HydrationContext");

export const HydrationContextLive = Layer.scoped(
	HydrationContext,
	Effect.gen(function* () {
		const ref = yield* Ref.make(false);
		return {
			isHydrating: () => Ref.get(ref),
			setHydrating: (value: boolean) => Ref.set(ref, value),
		};
	}),
);

export const HydrationContextNoop = Layer.succeed(HydrationContext, {
	isHydrating: () => Effect.succeed(false),
	setHydrating: () => Effect.void,
});
