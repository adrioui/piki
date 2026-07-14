import { Effect, Queue } from "effect";
import { describe, expect, it } from "vitest";
import { TraceBus, TraceBusLive, type TraceEvent } from "../../src/runtime/trace-bus.ts";

const sampleEvent = (type: string): TraceEvent => ({
	type,
	timestamp: "2025-01-01T00:00:00.000Z",
	payload: {},
});

describe("TraceBus", () => {
	it("emit returns void and does not fail", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const bus = yield* TraceBus;
				return yield* bus.emit(sampleEvent("agent_start"));
			}).pipe(Effect.provide(TraceBusLive)),
		);
		expect(result).toBeUndefined();
	});

	it("subscribe then emit then take receives events in order", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const bus = yield* TraceBus;
					// Subscribe BEFORE publishing (PubSub broadcasts to active subscribers)
					const subscription = yield* bus.subscribe();

					yield* bus.emit(sampleEvent("a"));
					yield* bus.emit(sampleEvent("b"));
					yield* bus.emit(sampleEvent("c"));

					const msg1 = yield* Queue.take(subscription);
					const msg2 = yield* Queue.take(subscription);
					const msg3 = yield* Queue.take(subscription);

					expect(msg1.type).toBe("a");
					expect(msg2.type).toBe("b");
					expect(msg3.type).toBe("c");
				}),
			).pipe(Effect.provide(TraceBusLive)),
		);
	});
});
