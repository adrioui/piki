// packages/event-core/src/runtime/hydration-context.ts
import { Context, Effect, Layer, Ref } from "effect";

export interface HydrationContextShape {
	/** Read whether we are currently hydrating (replaying events into projections). */
	readonly isHydrating: () => Effect.Effect<boolean>;
	/** Set the hydration flag. Called by EventSink.replay(). */
	readonly setHydrating: (value: boolean) => Effect.Effect<void>;
}

export const HydrationContext = Context.GenericTag<HydrationContextShape>("HydrationContext");

/**
 * Default live layer: starts with isHydrating=false.
 *
 * NOTE: the original design plan called for `Layer.scoped`, but `Layer.scoped`
 * does NOT exist in `effect@4.0.0-beta.93` — only `Layer.succeed`,
 * `Layer.effect` (auto-strips Scope from requirements), and
 * `Layer.effectContext`/`Layer.effectDiscard` exist. `Ref.make(false)` in
 * this beta returns `Effect<Ref<boolean>, never, never>` (no Scope needed),
 * so `Layer.effect` is the correct constructor here.
 */
export const HydrationContextLive = Layer.effect(
	HydrationContext,
	Effect.gen(function* () {
		const ref = yield* Ref.make(false);
		return {
			isHydrating: () => Ref.get(ref),
			setHydrating: (value: boolean) => Ref.set(ref, value),
		};
	}),
);

/** No-op layer for contexts where hydration tracking is irrelevant. */
export const HydrationContextNoop = Layer.succeed(HydrationContext, {
	isHydrating: () => Effect.succeed(false),
	setHydrating: () => Effect.void,
});
