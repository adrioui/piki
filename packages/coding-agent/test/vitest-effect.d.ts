import type { Effect } from "effect";

declare module "vitest" {
	interface TestAPI {
		effect: (name: string, fn: () => Effect.Effect<unknown, unknown, unknown>, timeout?: number) => void;
	}
}
