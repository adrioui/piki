import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { MemoryStorage, makeMemoryStorageLayer } from "../../src/effect/memory-storage.ts";

describe("MemoryStorage", () => {
	it.effect("set+get round-trip within TTL", () =>
		Effect.gen(function* () {
			let clock = 1000;
			const layer = makeMemoryStorageLayer({ capacity: 1024, now: () => clock });
			const mem = yield* Effect.provide(MemoryStorage, layer);

			yield* mem.set("key1", "hello", 500);
			const val = yield* mem.get<string>("key1");
			expect(val).toBe("hello");

			// advance past TTL
			clock = 1501;
			const expired = yield* mem.get<string>("key1");
			expect(expired).toBeUndefined();
		}),
	);

	it.effect("get returns undefined after TTL expiry", () =>
		Effect.gen(function* () {
			let clock = 0;
			const layer = makeMemoryStorageLayer({ now: () => clock });
			const mem = yield* Effect.provide(MemoryStorage, layer);

			yield* mem.set("k", "v", 100);

			clock = 99;
			expect(yield* mem.get("k")).toBe("v");

			clock = 100;
			expect(yield* mem.get("k")).toBeUndefined();
		}),
	);

	it.effect("LRU eviction: capacity=2, insert a,b,c → a evicted", () =>
		Effect.gen(function* () {
			let clock = 1000;
			const layer = makeMemoryStorageLayer({ capacity: 2, now: () => clock });
			const mem = yield* Effect.provide(MemoryStorage, layer);

			yield* mem.set("a", 1);
			clock++;
			yield* mem.set("b", 2);
			clock++;
			yield* mem.set("c", 3); // should evict "a" (oldest lastAccess)

			expect(yield* mem.get("a")).toBeUndefined();
			expect(yield* mem.get("b")).toBe(2);
			expect(yield* mem.get("c")).toBe(3);
			expect(yield* mem.size()).toBe(2);
		}),
	);

	it.effect("LRU recency: set a,b; get(a); insert c → b evicted", () =>
		Effect.gen(function* () {
			let clock = 1000;
			const layer = makeMemoryStorageLayer({ capacity: 2, now: () => clock });
			const mem = yield* Effect.provide(MemoryStorage, layer);

			yield* mem.set("a", 1);
			clock++;
			yield* mem.set("b", 2);
			clock++;

			// touch "a" so its lastAccess is newer
			yield* mem.get("a");
			clock++;

			yield* mem.set("c", 3); // should evict "b" (older lastAccess)

			expect(yield* mem.get("a")).toBe(1);
			expect(yield* mem.get("b")).toBeUndefined();
			expect(yield* mem.get("c")).toBe(3);
		}),
	);

	it.effect("TTL=Infinity survives sweep; sweepExpired reports correct count", () =>
		Effect.gen(function* () {
			let clock = 1000;
			const layer = makeMemoryStorageLayer({ now: () => clock });
			const mem = yield* Effect.provide(MemoryStorage, layer);

			yield* mem.set("eternal", "forever", Infinity);
			yield* mem.set("ephemeral", "gone", 100);
			yield* mem.set("also-ephemeral", "gone2", 200);

			// advance past "ephemeral" expiry (1000+100=1100) but not "also-ephemeral" (1000+200=1200)
			clock = 1150;
			const removed = yield* mem.sweepExpired();
			expect(removed).toBe(1);

			expect(yield* mem.get("eternal")).toBe("forever");
			expect(yield* mem.get("ephemeral")).toBeUndefined();
			expect(yield* mem.get("also-ephemeral")).toBe("gone2");

			// advance past "also-ephemeral" expiry (1000+200=1200)
			clock = 1250;
			const removed2 = yield* mem.sweepExpired();
			expect(removed2).toBe(1);
			expect(yield* mem.get("eternal")).toBe("forever");
		}),
	);

	it.effect("delete returns true/false correctly", () =>
		Effect.gen(function* () {
			const layer = makeMemoryStorageLayer();
			const mem = yield* Effect.provide(MemoryStorage, layer);

			yield* mem.set("exists", 42);
			const deleted = yield* mem.delete("exists");
			expect(deleted).toBe(true);

			const deletedAgain = yield* mem.delete("exists");
			expect(deletedAgain).toBe(false);

			const deletedMissing = yield* mem.delete("never-existed");
			expect(deletedMissing).toBe(false);

			expect(yield* mem.size()).toBe(0);
		}),
	);

	it.effect("size reflects current live entries after sweep", () =>
		Effect.gen(function* () {
			let clock = 0;
			const layer = makeMemoryStorageLayer({ now: () => clock });
			const mem = yield* Effect.provide(MemoryStorage, layer);

			yield* mem.set("a", 1, 50);
			yield* mem.set("b", 2, 150);
			yield* mem.set("c", 3, Infinity);

			expect(yield* mem.size()).toBe(3);

			clock = 100;
			expect(yield* mem.size()).toBe(2); // "a" swept

			clock = 200;
			expect(yield* mem.size()).toBe(1); // "b" swept, only "c" remains
		}),
	);
});
