import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { HydrationContext, HydrationContextLive, HydrationContextNoop } from "../../src/runtime/hydration-context.ts";

describe("HydrationContext", () => {
	it("live layer starts with isHydrating() === false", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ctx = yield* HydrationContext;
				return yield* ctx.isHydrating();
			}).pipe(Effect.provide(HydrationContextLive)),
		);
		expect(result).toBe(false);
	});

	it("setHydrating(true) then setHydrating(false) round-trips", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ctx = yield* HydrationContext;
				yield* ctx.setHydrating(true);
				const t = yield* ctx.isHydrating();
				expect(t).toBe(true);
				yield* ctx.setHydrating(false);
				return yield* ctx.isHydrating();
			}).pipe(Effect.provide(HydrationContextLive)),
		);
		expect(result).toBe(false);
	});

	it("noop layer always returns false", async () => {
		const initial = await Effect.runPromise(
			Effect.gen(function* () {
				const ctx = yield* HydrationContext;
				yield* ctx.setHydrating(true);
				return yield* ctx.isHydrating();
			}).pipe(Effect.provide(HydrationContextNoop)),
		);
		expect(initial).toBe(false);
	});
});
