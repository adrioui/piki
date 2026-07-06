import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectionStore } from "../../src/projection.ts";
import { RoleHost } from "../../src/role.ts";
import {
	EventSinkTag,
	FrameworkErrorReporter,
	HydrationContext,
	makeFoundationRuntime,
	ProjectionStoreTag,
	RoleHostTag,
	TraceBus,
} from "../../src/runtime/index.ts";
import { DefaultEventSink } from "../../src/sink.ts";
import { InMemoryEventStore } from "../../src/store.ts";
import type { EventEnvelope } from "../../src/types.ts";

function makeFoundationDeps() {
	const store = new InMemoryEventStore<EventEnvelope>();
	const projectionStore = new ProjectionStore<EventEnvelope>();
	const roleHost = new RoleHost<EventEnvelope>({
		projections: projectionStore,
		publish: async () => {},
	});
	const sink = new DefaultEventSink<EventEnvelope>(store, { projectionStore });
	return { sink, projectionStore, roleHost };
}

describe("FoundationRuntime", () => {
	it("resolves all 6 foundation services through ManagedRuntime", async () => {
		const deps = makeFoundationDeps();
		const runtime = makeFoundationRuntime(deps);

		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const hydration = yield* HydrationContext;
					const reporter = yield* FrameworkErrorReporter;
					const trace = yield* TraceBus;
					const sinkTag = yield* EventSinkTag;
					const storeTag = yield* ProjectionStoreTag;
					const hostTag = yield* RoleHostTag;
					return {
						hydration,
						reporter,
						trace,
						sink: sinkTag.sink,
						projectionStore: storeTag.store,
						roleHost: hostTag.host,
					};
				}),
			);

			expect(typeof result.hydration.isHydrating).toBe("function");
			expect(typeof result.reporter.report).toBe("function");
			expect(typeof result.trace.subscribe).toBe("function");
			expect(result.sink).toBe(deps.sink);
			expect(result.projectionStore).toBe(deps.projectionStore);
			expect(result.roleHost).toBe(deps.roleHost);
		} finally {
			await runtime.dispose();
		}
	});

	it("dispose is idempotent", async () => {
		const runtime = makeFoundationRuntime(makeFoundationDeps());

		await expect(runtime.dispose()).resolves.toBeUndefined();
		await expect(runtime.dispose()).resolves.toBeUndefined();
	});
});
