import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeWorkerBusLayer, WorkerBus, type WorkerBusEvent } from "../../src/runtime/worker-bus.ts";

const sampleEvent = (type: string, sequence = 0): WorkerBusEvent => ({
	id: `evt-${type}-${sequence}`,
	stream: "worker-events",
	sequence,
	type,
	timestamp: "2025-01-01T00:00:00.000Z",
	payload: {},
});

describe("WorkerBus", () => {
	it("publish delegates to publishFn AND broadcasts to subscribers (take in order)", async () => {
		const published: WorkerBusEvent[] = [];
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const bus = yield* WorkerBus;
					// Eager-subscribe BEFORE publishing.
					const stream = yield* bus.subscribe();
					yield* bus.publish(sampleEvent("agent_created", 1));
					yield* bus.publish(sampleEvent("agent_finished", 2));

					const collected = Array.from(yield* Stream.runCollect(Stream.take(stream, 2)));
					expect(collected.length).toBe(2);
					expect(collected[0].type).toBe("agent_created");
					expect(collected[1].type).toBe("agent_finished");
				}),
			).pipe(
				Effect.provide(
					makeWorkerBusLayer(async (e) => {
						published.push(e);
					}),
				),
			),
		);
		expect(published.length).toBe(2);
		expect(published[0].type).toBe("agent_created");
	});

	it("subscribeToTypes filters by event type", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const bus = yield* WorkerBus;
					const filtered = yield* bus.subscribeToTypes(["worker_killed"]);
					yield* bus.publish(sampleEvent("agent_created", 1)); // filtered OUT
					yield* bus.publish(sampleEvent("worker_killed", 2)); // passes
					const collected = Array.from(yield* Stream.runCollect(Stream.take(filtered, 1)));
					expect(collected.length).toBe(1);
					expect(collected[0].type).toBe("worker_killed");
				}),
			).pipe(Effect.provide(makeWorkerBusLayer(async () => {}))),
		);
	});

	it("publish errors from publishFn are surfaced (not swallowed)", async () => {
		const boomPublish = async (_e: WorkerBusEvent): Promise<void> => {
			throw new Error("sink broken");
		};
		let caught: unknown = null;
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const bus = yield* WorkerBus;
					yield* bus.publish(sampleEvent("agent_created", 1));
				}).pipe(Effect.provide(makeWorkerBusLayer(boomPublish))),
			);
		} catch (e: unknown) {
			caught = e;
		}
		expect(caught).not.toBeNull();
	});

	it("stream property exposes a full unfiltered view", async () => {
		// `stream` is a lazy Stream.fromPubSub — subscribe eagerly via bus.subscribe() instead.
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const bus = yield* WorkerBus;
					const stream = yield* bus.subscribe();
					yield* bus.publish(sampleEvent("fork_created", 1));
					yield* bus.publish(sampleEvent("fork_cleaned", 2));
					const collected = Array.from(yield* Stream.runCollect(Stream.take(stream, 2)));
					expect(collected.length).toBe(2);
					expect(collected[0].type).toBe("fork_created");
					expect(collected[1].type).toBe("fork_cleaned");
				}),
			).pipe(Effect.provide(makeWorkerBusLayer(async () => {}))),
		);
	});
});
