import { Context, Deferred, Effect, Layer, SynchronizedRef } from "effect";

interface Entry {
	readonly executionEpoch: number;
	readonly interruptEpoch: number;
	readonly waiters: Set<Deferred.Deferred<void>>;
}

interface Baseline {
	readonly executionEpoch: number;
	readonly interruptEpoch: number;
}

function emptyEntry(): Entry {
	return { executionEpoch: 0, interruptEpoch: 0, waiters: new Set() };
}

function toBaseline(entry: Entry): Baseline {
	return { executionEpoch: entry.executionEpoch, interruptEpoch: entry.interruptEpoch };
}

function wakeWaiters(waiters: Set<Deferred.Deferred<void>>): Effect.Effect<void> {
	return Effect.forEach(Array.from(waiters), (waiter) => Deferred.succeed(waiter, undefined), { discard: true });
}

export interface InterruptCoordinatorShape {
	readonly beginExecution: (forkId: string | null) => Effect.Effect<Baseline>;
	readonly current: (forkId: string | null) => Effect.Effect<Baseline>;
	readonly interrupt: (forkId: string | null) => Effect.Effect<void>;
	readonly waitForInterrupt: (forkId: string | null, baseline: Baseline) => Effect.Effect<never>;
}

export const InterruptCoordinator = Context.GenericTag<InterruptCoordinatorShape>("@piki/InterruptCoordinator");

export const InterruptCoordinatorLive = Layer.scoped(
	InterruptCoordinator,
	Effect.gen(function* () {
		const state = yield* SynchronizedRef.make(new Map<string | null, Entry>());
		return {
			beginExecution: (forkId) =>
				SynchronizedRef.modifyEffect(state, (map) => {
					const current = map.get(forkId) ?? emptyEntry();
					const next: Entry = {
						executionEpoch: current.executionEpoch + 1,
						interruptEpoch: 0,
						waiters: new Set(),
					};
					const nextMap = new Map(map);
					nextMap.set(forkId, next);
					return Effect.as(wakeWaiters(current.waiters), [toBaseline(next), nextMap] as const);
				}),
			current: (forkId) =>
				SynchronizedRef.modifyEffect(state, (map) =>
					Effect.succeed([toBaseline(map.get(forkId) ?? emptyEntry()), map] as const),
				),
			interrupt: (forkId) =>
				SynchronizedRef.modifyEffect(state, (map) => {
					const current = map.get(forkId) ?? emptyEntry();
					const next: Entry = {
						executionEpoch: current.executionEpoch,
						interruptEpoch: current.interruptEpoch + 1,
						waiters: new Set(),
					};
					const nextMap = new Map(map);
					nextMap.set(forkId, next);
					return Effect.as(wakeWaiters(current.waiters), [undefined, nextMap] as const);
				}),
			waitForInterrupt: (forkId, baseline) =>
				Effect.forever(
					Effect.flatMap(Deferred.make<void>(), (waiter) =>
						SynchronizedRef.modifyEffect(state, (map) => {
							const current = map.get(forkId) ?? emptyEntry();
							if (
								current.executionEpoch === baseline.executionEpoch &&
								current.interruptEpoch > baseline.interruptEpoch
							) {
								return Effect.interrupt.pipe(Effect.map(() => [undefined, map] as const));
							}
							const nextEntry: Entry = {
								...current,
								waiters: new Set(current.waiters).add(waiter),
							};
							const nextMap = new Map(map);
							nextMap.set(forkId, nextEntry);
							return Effect.succeed([waiter, nextMap] as const);
						}).pipe(
							Effect.flatMap((registeredWaiter) =>
								registeredWaiter === undefined ? Effect.void : Deferred.await(registeredWaiter),
							),
						),
					),
				),
		};
	}),
);
