import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { Ambient, AmbientLive, UnregisteredAmbientDefect } from "../../src/runtime/ambient-service.ts";

describe("Ambient (G13)", () => {
	it("register + lookup round-trips, overwrites on re-register, returns undefined for missing", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ambient = yield* Ambient;
				yield* ambient.register("search", { query: "q" });
				const first = yield* ambient.lookup<{ query: string }>("search");
				const missing = yield* ambient.lookup<{ query: string }>("missing");
				yield* ambient.register("search", { query: "updated" });
				const second = yield* ambient.lookup<{ query: string }>("search");
				return { first, missing, second };
			}).pipe(Effect.provide(AmbientLive)),
		);
		expect(result.first).toEqual({ query: "q" });
		expect(result.missing).toBeUndefined();
		expect(result.second).toEqual({ query: "updated" });
	});

	it("depend dies with UnregisteredAmbientDefect when missing, succeeds when registered", async () => {
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const ambient = yield* Ambient;
					return yield* ambient.depend<unknown>("db");
				}).pipe(Effect.provide(AmbientLive)),
			);
			throw new Error("expected depend to die but it resolved");
		} catch (err) {
			const defect = err as UnregisteredAmbientDefect;
			expect(defect).toBeInstanceOf(UnregisteredAmbientDefect);
			expect(defect._tag).toBe("UnregisteredAmbientDefect");
			expect(defect.ambientName).toBe("db");
		}

		const value = await Effect.runPromise(
			Effect.gen(function* () {
				const ambient = yield* Ambient;
				yield* ambient.register("db", { conn: "x" });
				return yield* ambient.depend<{ conn: string }>("db");
			}).pipe(Effect.provide(AmbientLive)),
		);
		expect(value).toEqual({ conn: "x" });
	});

	it("each scoped runtime build gets an isolated Map (registry does not leak across scopes)", async () => {
		const runtimeA = ManagedRuntime.make(AmbientLive);
		const runtimeB = ManagedRuntime.make(AmbientLive);
		try {
			await runtimeA.runPromise(
				Effect.gen(function* () {
					const ambient = yield* Ambient;
					yield* ambient.register("k", "A-value");
				}),
			);
			const bResult = await runtimeB.runPromise(
				Effect.gen(function* () {
					const ambient = yield* Ambient;
					return yield* ambient.lookup<string>("k");
				}),
			);
			expect(bResult).toBeUndefined();
		} finally {
			await runtimeA.dispose();
			await runtimeB.dispose();
		}
	});
});
