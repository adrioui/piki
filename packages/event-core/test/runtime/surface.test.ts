import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectionStore } from "../../src/projection.ts";
import { RoleHost } from "../../src/role.ts";
import {
	EventSinkTag,
	makeEventSinkLayer,
	makeProjectionStoreLayer,
	makeRoleHostLayer,
	makeSurfaceClient,
	SurfaceCommand,
	type SurfaceCtx,
	SurfaceLayer,
} from "../../src/runtime/index.ts";
import { DefaultEventSink } from "../../src/sink.ts";
import { InMemoryEventStore } from "../../src/store.ts";
import type { EventEnvelope } from "../../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFoundationDeps() {
	const store = new InMemoryEventStore<EventEnvelope>();
	const projectionStore = new ProjectionStore<EventEnvelope>();
	const roleHost = new RoleHost<EventEnvelope>({
		projections: projectionStore,
		publish: async () => {},
	});
	const sink = new DefaultEventSink<EventEnvelope>(store, { projectionStore });
	return { sink, projectionStore, roleHost, store };
}

/** Minimal event envelope matching pi's shape. */
function testEvent(overrides?: Partial<EventEnvelope>): EventEnvelope {
	return {
		id: crypto.randomUUID(),
		stream: "test",
		sequence: 1,
		type: "test-type",
		timestamp: new Date().toISOString(),
		payload: { hello: "world" },
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Surface", () => {
	it("binds a publish command routed through EventSinkTag", async () => {
		const deps = makeFoundationDeps();

		const publishCommand = SurfaceCommand(
			(e: EventEnvelope) =>
				Effect.gen(function* () {
					const sinkTag = yield* EventSinkTag;
					return yield* Effect.promise(() => sinkTag.sink.publish(e));
				}) as unknown as Effect.Effect<void, never, SurfaceCtx>,
		);

		const surface = { publish: publishCommand };

		const layer = Layer.mergeAll(
			SurfaceLayer,
			makeProjectionStoreLayer(deps.projectionStore),
			makeRoleHostLayer(deps.roleHost),
			makeEventSinkLayer(deps.sink),
		);

		const client = await Effect.runPromise(
			makeSurfaceClient(surface).pipe(Effect.provide(layer)) as Effect.Effect<typeof surface, never, never>,
		);

		const event = testEvent();
		const publish = client.publish as unknown as (e: EventEnvelope) => Effect.Effect<unknown>;
		await Effect.runPromise(publish(event));

		const stored = deps.store.list();
		expect(stored).toHaveLength(1);
		expect(stored[0].id).toBe(event.id);
		expect(stored[0].type).toBe(event.type);
		expect(stored[0].payload).toEqual(event.payload);
	});

	// -----------------------------------------------------------------------
	// Test 2: Signal stream fan-out through TraceBus
	// -----------------------------------------------------------------------

	it.skip("subscribes to a TraceBus signal stream and receives emitted events", async () => {
		// Scenario: a surface has a subscribeAll SurfaceSignalStream that
		// reads from TraceBus.changes. The test binds it, emits a trace
		// event, the subscriber receives it.
		//
		// Implementation sketch:
		//   const subscribeAll = SurfaceSignalStream(
		//     Stream.fromPubSub(traceBus.pubsub).pipe(...),
		//   );
		//   const surface = { subscribeAll };
		//   const layer = Layer.mergeAll(SurfaceLayer, ...);
		//   const { client, dispose } = makeVanillaClient(layer, surface);
		//   const received: unknown[] = [];
		//   const unsub = client.subscribeAll((v) => received.push(v));
		//   // emit through TraceBus...
		//   await sleep(10);
		//   expect(received.length).toBeGreaterThan(0);
		//   unsub();
		//   await dispose();
	});

	// -----------------------------------------------------------------------
	// Test 3: vanillaClient dispose interrupts active stream subscriptions
	// -----------------------------------------------------------------------

	it.skip("vanilla client dispose interrupts active streams and rejects subsequent calls", async () => {
		// Scenario: subscribe, emit, unsubscribe, then dispose.
		// After dispose, a subsequent emit throws because the runtime's
		// fibers were interrupted.
		//
		// Implementation sketch:
		//   const { client, dispose } = makeVanillaClient(layer, surface);
		//   const unsub = client.subscribeAll((v) => {});
		//   unsub();
		//   await dispose();
		//   expect(() => client.subscribeAll(() => {})).toThrow("disposed");
	});
});
