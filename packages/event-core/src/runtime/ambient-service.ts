// packages/event-core/src/runtime/ambient-service.ts
import { Context, Data, Effect, Layer, Ref } from "effect";

/** Defect raised by `depend()` when no service is registered under `name`.
 *  A missing ambient is a programming error (defect),
 *  not a recoverable failure — callers wanting recovery should use `lookup`. */
export class UnregisteredAmbientDefect extends Data.TaggedError("UnregisteredAmbientDefect")<{
	readonly ambientName: string;
}> {}

/** Protocol-agnostic service registry. Survives bus reattach by holding
 *  registrations in a scoped Map so a re-attached bus reads the same registry.
 *  G13 is registry-only (`register`/`lookup`/`depend`); bus coupling + the
 *  `update(def, value)` + `bus.processAmbientChange` path is G18 (arch4b). */
export interface AmbientShape {
	/** Register `service` under `name`. Idempotent: re-registering overwrites. */
	readonly register: <T>(name: string, service: T) => Effect.Effect<void>;
	/** Return the service registered under `name`, or `undefined` if none. */
	readonly lookup: <T>(name: string) => Effect.Effect<T | undefined>;
	/** Return the service registered under `name`; die with UnregisteredAmbientDefect if missing. */
	readonly depend: <T>(name: string) => Effect.Effect<T>;
}

export const Ambient = Context.GenericTag<AmbientShape>("Ambient");

/**
 * Live layer: a fresh scoped Map per scope build.
 *
 * Uses copy-on-write (`new Map(m).set(...)`) so the registry is safe under
 * concurrent fiber access; ambient registration is expected to be single-fiber
 * at bus-attach time, but copy-on-write is defensive against G18's future
 * bus-dispatch concurrency.
 *
 * NOTE: the original design plan called for `Layer.scoped`, but `Layer.scoped`
 * does NOT exist in `effect@4.0.0-beta.93` — `Layer.effect` (which auto-strips
 * Scope from requirements) is the correct constructor. `Ref.make(...)` in this
 * beta returns `Effect<Ref<...>, never, never>` (no Scope needed).
 */
export const AmbientLive = Layer.effect(
	Ambient,
	Effect.gen(function* () {
		const ref = yield* Ref.make(new Map<string, unknown>());
		return {
			register: <T>(name: string, service: T) => Ref.update(ref, (m) => new Map(m).set(name, service)),
			lookup: <T>(name: string) => Effect.map(Ref.get(ref), (m) => m.get(name) as T | undefined),
			depend: <T>(name: string) =>
				Effect.gen(function* () {
					const m = yield* Ref.get(ref);
					const v = m.get(name);
					if (v === undefined) {
						yield* Effect.die(new UnregisteredAmbientDefect({ ambientName: name }));
					}
					return v as T;
				}),
		};
	}),
);
