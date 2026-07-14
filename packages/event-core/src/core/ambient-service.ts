import { Context, Data, Effect, Layer } from "effect";
import { ProjectionBus } from "./projection-bus.ts";

export class UnregisteredAmbientDefect extends Data.TaggedError("UnregisteredAmbientDefect")<{
	readonly ambientName: string;
}> {}

export interface AmbientDef<T = unknown> {
	readonly name: string;
	readonly initial: T | Effect.Effect<T>;
	readonly _type: undefined;
}

export interface AmbientServiceShape {
	readonly register: (def: AmbientDef) => Effect.Effect<void, any, any>;
	readonly getValue: <T>(def: AmbientDef<T>) => T;
	readonly update: (def: AmbientDef, value: unknown) => Effect.Effect<void, any, any>;
}

export const AmbientServiceTag = Context.GenericTag<AmbientServiceShape>("@piki/AmbientService");

export function makeAmbientServiceLayer() {
	return Layer.scoped(
		AmbientServiceTag,
		Effect.gen(function* () {
			const bus = yield* ProjectionBus;
			const snapshots = new Map<AmbientDef<any>, { value: any; version: number }>();
			return {
				register(def) {
					if (snapshots.has(def)) return Effect.void;
					return Effect.gen(function* () {
						const initial = Effect.isEffect(def.initial) ? yield* def.initial : def.initial;
						snapshots.set(def, { value: initial, version: 0 });
					});
				},
				getValue<T>(def: AmbientDef<T>): T {
					return snapshots.get(def)!.value;
				},
				update(def, value) {
					const current = snapshots.get(def);
					if (!current) return Effect.die(new UnregisteredAmbientDefect({ ambientName: def.name }));
					snapshots.set(def, { value, version: current.version + 1 });
					return bus.processAmbientChange(def.name, value);
				},
			};
		}),
	);
}
