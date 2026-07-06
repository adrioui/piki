import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectionStore } from "../../src/projection.ts";
import { RoleHost } from "../../src/role.ts";
import { HydrationContext } from "../../src/runtime/hydration-context.ts";
import { EventSinkTag, makeFoundationRuntime, ProjectionStoreTag, RoleHostTag } from "../../src/runtime/index.ts";
import { DefaultEventSink } from "../../src/sink.ts";
import { InMemoryEventStore } from "../../src/store.ts";
import type { EventEnvelope } from "../../src/types.ts";

function makeRuntime() {
	const projectionStore = new ProjectionStore<EventEnvelope>();
	const roleHost = new RoleHost<EventEnvelope>({
		projections: projectionStore,
		publish: async () => {},
	});
	const store = new InMemoryEventStore<EventEnvelope>();
	const sink = new DefaultEventSink<EventEnvelope>(store, { projectionStore });
	return makeFoundationRuntime({ sink, projectionStore, roleHost });
}

describe("DefaultEventSink effectRuntime injection", () => {
	it("replay() with a runtime runs the Effect block without throwing and ends with flag=false", async () => {
		const projectionStore = new ProjectionStore<EventEnvelope>();
		const store = new InMemoryEventStore<EventEnvelope>();
		const runtime = makeRuntime();

		const sink = new DefaultEventSink<EventEnvelope>(store, {
			projectionStore,
			effectRuntime: runtime,
		});

		// Fire-and-forget Effect block is scheduled by replay(); trigger it.
		expect(() => sink.replay([])).not.toThrow();

		// Probe the flag through the same runtime after the fire-and-forget resolves.
		const finalFlag = await runtime.runPromise(
			Effect.gen(function* () {
				const ctx = yield* HydrationContext;
				return yield* ctx.isHydrating();
			}),
		);
		expect(finalFlag).toBe(false);
		await runtime.dispose();
	});

	it("replay() without a runtime is backwards compatible (no throw)", () => {
		const projectionStore = new ProjectionStore<EventEnvelope>();
		const store = new InMemoryEventStore<EventEnvelope>();
		const sink = new DefaultEventSink<EventEnvelope>(store, { projectionStore });

		expect(() => sink.replay([])).not.toThrow();
	});

	it("runtime resolves all foundation Tags", async () => {
		const runtime = makeRuntime();
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					yield* HydrationContext;
					yield* EventSinkTag;
					yield* ProjectionStoreTag;
					yield* RoleHostTag;
				}),
			);
		} finally {
			await runtime.dispose();
		}
		expect.assertions(0);
	});
});
