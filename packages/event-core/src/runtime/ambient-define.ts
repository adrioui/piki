// packages/event-core/src/runtime/ambient-define.ts
import type { Effect } from "effect";

/**
 * An ambient definition: a name plus an (optionally Effect) initial value.
 * Mirrors magnitude's ambient/define (typed; no untyped `_type` sentinel).
 */
export interface AmbDef<T = unknown> {
	readonly name: string;
	readonly initial: T | Effect.Effect<T>;
}

/** Factory mirroring magnitude's `define`. */
export function defineAmbient<T>(options: {
	readonly name: string;
	readonly initial: T | Effect.Effect<T>;
}): AmbDef<T> {
	return { name: options.name, initial: options.initial };
}
