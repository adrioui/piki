import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Trace, type TraceEvent, TraceNoop, traceEventFromEnvelope } from "../../src/runtime/trace.ts";

describe("Trace", () => {
	it("TraceNoop.onEvent resolves void and has no side effects", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const trace = yield* Trace;
				return yield* trace.onEvent({
					type: "agent_start",
					timestamp: "2025-01-01T00:00:00.000Z",
					payload: {},
				});
			}).pipe(Effect.provide(TraceNoop)),
		);
		expect(result).toBeUndefined();
	});

	it("traceEventFromEnvelope maps type, timestamp, sessionId, payload", () => {
		const env = {
			type: "turn_end",
			timestamp: "2025-01-01T00:00:01.000Z",
			sessionId: "sess-123",
			payload: { toolCallCount: 3 },
		};
		const event = traceEventFromEnvelope(env);
		expect(event.type).toBe("turn_end");
		expect(event.timestamp).toBe("2025-01-01T00:00:01.000Z");
		expect(event.sessionId).toBe("sess-123");
		expect(event.payload).toEqual({ toolCallCount: 3 });
	});

	it("traceEventFromEnvelope omits persistence fields and defaults payload to {}", () => {
		const env = {
			type: "agent_start",
			timestamp: "2025-01-01T00:00:00.000Z",
			payload: null,
		};
		const event = traceEventFromEnvelope(env);
		expect(event.sessionId).toBeUndefined();
		expect(event.forkId).toBeUndefined();
		expect(event.payload).toEqual({});
	});

	it("custom Trace listener collects emitted events", async () => {
		const events: TraceEvent[] = [];
		const customLayer = Layer.succeed(Trace, {
			onEvent: (event: TraceEvent) =>
				Effect.sync(() => {
					events.push(event);
				}),
		});

		await Effect.runPromise(
			Effect.gen(function* () {
				const trace = yield* Trace;
				yield* trace.onEvent({ type: "test", timestamp: "t1", payload: { n: 1 } });
				yield* trace.onEvent({ type: "test", timestamp: "t2", payload: { n: 2 } });
			}).pipe(Effect.provide(customLayer)),
		);

		expect(events.length).toBe(2);
		expect(events[0].payload).toEqual({ n: 1 });
		expect(events[1].payload).toEqual({ n: 2 });
	});
});
