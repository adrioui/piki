import type { Effect } from "effect";

export interface AmbDef<T = unknown> {
	readonly name: string;
	readonly initial: T | Effect.Effect<T>;
	readonly _type: undefined;
}

export function define<T>(options: { readonly name: string; readonly initial: T | Effect.Effect<T> }): AmbDef<T> {
	return { name: options.name, initial: options.initial, _type: undefined };
}
