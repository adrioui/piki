import { Context, Effect, Layer, Ref } from "effect";

export interface MemoryEntry<V> {
	readonly value: V;
	readonly expiresAt: number; // epoch ms; Infinity = no TTL
	readonly lastAccess: number; // epoch ms; for LRU eviction tiebreak
}

export interface MemoryStorageShape {
	/** Get a key, returning undefined if expired or absent (also evicts if expired). */
	readonly get: <V = unknown>(key: string) => Effect.Effect<V | undefined>;
	/** Set a key with optional TTL (ms). ttlMs=undefined or Infinity => no expiry. */
	readonly set: <V = unknown>(key: string, value: V, ttlMs?: number) => Effect.Effect<void>;
	/** Delete a key. Returns true if present. */
	readonly delete: (key: string) => Effect.Effect<boolean>;
	/** Number of live entries (after a sweep). */
	readonly size: () => Effect.Effect<number>;
	/** Force a sweep of expired entries (also runs on every get/set). */
	readonly sweepExpired: () => Effect.Effect<number>;
}

export const MemoryStorage = Context.GenericTag<MemoryStorageShape>("@piki/MemoryStorage");

export const DEFAULT_MEMORY_CAPACITY = 1024;

/**
 * Live layer. Holds state in a closed Ref<Map<string, MemoryEntry<unknown>>>.
 * LRU eviction: on set, if size > capacity, evict the entry with the smallest
 * lastAccess (sweep expired first; if still over, evict LRU until under cap).
 * get()/set()/delete() are O(1)-ish; sweepExpired is O(n).
 */
export function makeMemoryStorageLayer(opts?: {
	capacity?: number;
	/** Inject a clock function for testability. Defaults to Date.now. */
	now?: () => number;
}) {
	const capacity = opts?.capacity ?? DEFAULT_MEMORY_CAPACITY;
	const now = opts?.now ?? (() => Date.now());

	return Layer.scoped(
		MemoryStorage,
		Effect.gen(function* () {
			const store = yield* Ref.make<Map<string, MemoryEntry<unknown>>>(new Map());

			const sweep = (): Effect.Effect<number> =>
				Ref.modify(store, (m) => {
					const t = now();
					let removed = 0;
					for (const [k, e] of m) {
						if (e.expiresAt !== Infinity && e.expiresAt <= t) {
							m.delete(k);
							removed++;
						}
					}
					return [removed, m];
				});

			const evictLRU = (): Effect.Effect<void> =>
				Ref.update(store, (m) => {
					while (m.size > capacity) {
						let lruKey: string | undefined;
						let lruTs = Infinity;
						for (const [k, e] of m) {
							if (e.lastAccess < lruTs) {
								lruTs = e.lastAccess;
								lruKey = k;
							}
						}
						if (lruKey !== undefined) {
							m.delete(lruKey);
						} else {
							break;
						}
					}
					return m;
				});

			return {
				get: <V = unknown>(key: string): Effect.Effect<V | undefined> =>
					Ref.modify(store, (m) => {
						const t = now();
						const e = m.get(key);
						if (e === undefined) {
							return [undefined, m];
						}
						if (e.expiresAt !== Infinity && e.expiresAt <= t) {
							m.delete(key);
							return [undefined, m];
						}
						m.set(key, { ...e, lastAccess: t });
						return [e.value as V, m];
					}),

				set: <V = unknown>(key: string, value: V, ttlMs?: number): Effect.Effect<void> =>
					Effect.gen(function* () {
						yield* sweep();
						const t = now();
						const expiresAt = ttlMs === undefined || ttlMs === Infinity ? Infinity : t + ttlMs;
						yield* Ref.update(store, (m) => {
							m.set(key, { value, expiresAt, lastAccess: t });
							return m;
						});
						yield* evictLRU();
					}),

				delete: (key: string): Effect.Effect<boolean> =>
					Ref.modify(store, (m) => {
						const existed = m.delete(key);
						return [existed, m];
					}),

				size: (): Effect.Effect<number> =>
					Effect.gen(function* () {
						yield* sweep();
						const m = yield* Ref.get(store);
						return m.size;
					}),

				sweepExpired: (): Effect.Effect<number> => sweep(),
			};
		}),
	);
}
