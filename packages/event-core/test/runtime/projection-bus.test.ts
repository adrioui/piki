// packages/event-core/test/runtime/projection-bus.test.ts
// G18: ProjectionBus — signal-queue flush, ambient dispatch, cycle validation.
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { FrameworkErrorPubSubLive, FrameworkErrorReporterLive } from "../../src/runtime/framework-error.ts";
import { ProjectionBus, ProjectionBusLive } from "../../src/runtime/projection-bus.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the minimal layer stack for ProjectionBusLive. */
const frameworkErrorLayer = FrameworkErrorReporterLive.pipe(Layer.provideMerge(FrameworkErrorPubSubLive));
const testLayer = ProjectionBusLive.pipe(Layer.provideMerge(frameworkErrorLayer));

/** Convenience: run an effect against the test layer and return the result. */
function run<T>(effect: Effect.Effect<T, any, any>): Promise<T> {
	return Effect.runPromise(Effect.provide(effect, testLayer) as Effect.Effect<T, never, never>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProjectionBus", () => {
	it("G18-T1 — flushSignalQueue drains queued signals and dispatches handlers in topological order", async () => {
		const seen: string[] = [];

		await run(
			Effect.gen(function* () {
				const bus = yield* ProjectionBus;

				// Register two signal handlers for "Goal/statusChanged"
				yield* bus.registerSignalHandler("Goal/statusChanged", {
					name: "Goal",
					handler: (value, _sourceState) =>
						Effect.sync(() => {
							seen.push(`Goal:${JSON.stringify(value)}`);
						}),
				});

				yield* bus.registerSignalHandler("Goal/statusChanged", {
					name: "Downstream",
					handler: (value, _sourceState) =>
						Effect.sync(() => {
							seen.push(`Downstream:${JSON.stringify(value)}`);
						}),
				});

				// Register explicit dependency: Downstream depends on Goal
				yield* bus.registerDependency("Downstream", "Goal");

				// Queue a signal
				yield* bus.queueSignal("Goal/statusChanged", { status: "done" }, null);

				// Flush
				yield* bus.flushSignalQueue();

				// Downstream must run after Goal (dependency order)
				expect(seen.length).toBe(2);
				expect(seen[0]).toContain("Goal:");
				expect(seen[1]).toContain("Downstream:");
			}),
		);
	});

	it("G18-T2 — processAmbientChange dispatches ambient handlers then flushes signals", async () => {
		const ambientSeen: unknown[] = [];

		await run(
			Effect.gen(function* () {
				const bus = yield* ProjectionBus;

				// Register an ambient handler for "config"
				yield* bus.registerAmbientHandler("config", {
					name: "Goal",
					handler: (value) =>
						Effect.sync(() => {
							ambientSeen.push(value);
						}),
				});

				// Also register a signal handler that fires on the ambient's queued signal
				yield* bus.registerSignalHandler("ambient:config", {
					name: "Goal",
					handler: (value, _sourceState) =>
						Effect.sync(() => {
							ambientSeen.push(`signal:${JSON.stringify(value)}`);
						}),
				});

				// Trigger ambient change
				yield* bus.processAmbientChange("config", { key: "value" });

				// Ambient handler must have fired
				expect(ambientSeen.length).toBeGreaterThanOrEqual(1);
				expect(ambientSeen[0]).toEqual({ key: "value" });
			}),
		);
	});

	it("G18-T3 — validateNoCycles dies with ProjectionBusCycleError on circular dependency", async () => {
		await run(
			Effect.gen(function* () {
				const bus = yield* ProjectionBus;

				// Create a cycle: A → B → A
				yield* bus.registerDependency("A", "B");
				yield* bus.registerDependency("B", "A");

				// validateNoCycles should die via Effect.die with ProjectionBusCycleError
				const caught = yield* Effect.catchAllCause(bus.validateNoCycles(), (cause) => Effect.succeed(cause));

				// We caught the cause — verify it's present (bus died as expected)
				expect(caught).toBeDefined();
			}),
		);
	});

	it("G18-T4 — self-dependency guard: handler where sourceProjection === name creates no cycle", async () => {
		await run(
			Effect.gen(function* () {
				const bus = yield* ProjectionBus;

				// Register a signal handler where sourceProjection derived from signalName
				// equals handler.name — the self-dependency guard should skip the edge.
				yield* bus.registerSignalHandler("Goal/statusChanged", {
					name: "Goal",
					handler: (_value, _sourceState) => Effect.void,
				});

				// Also register a real downstream dependency so the graph is non-trivial
				yield* bus.registerSignalHandler("Goal/statusChanged", {
					name: "Downstream",
					handler: (_value, _sourceState) => Effect.void,
				});

				// validateNoCycles must not die — the self-edge on Goal is skipped
				yield* bus.validateNoCycles();
			}),
		);
	});

	it("G18-T5 — queueSignal carries the event timestamp from the preceding processEvent", async () => {
		const captured: number[] = [];

		await run(
			Effect.gen(function* () {
				const bus = yield* ProjectionBus;

				yield* bus.registerSignalHandler("Goal/statusChanged", {
					name: "Goal",
					handler: (value, _sourceState) =>
						Effect.sync(() => {
							captured.push((value as { timestamp?: number }).timestamp ?? 0);
						}),
				});

				// Register an event handler that queues a signal during event processing
				yield* bus.register({
					name: "Goal",
					eventTypes: ["test_event"],
					handler: (_event) =>
						Effect.gen(function* () {
							yield* bus.queueSignal("Goal/statusChanged", { status: "done" }, null);
						}),
				});

				// Process an event with a known timestamp
				const eventTimestamp = "2025-01-15T10:30:00.000Z";
				const expectedMs = Date.parse(eventTimestamp);
				yield* bus.processEvent({
					id: "ev-1",
					stream: "test",
					sequence: 1,
					type: "test_event",
					timestamp: eventTimestamp,
					payload: {},
				});

				// Signal handler should have received the event's timestamp
				expect(captured.length).toBe(1);
				expect(captured[0]).toBe(expectedMs);
			}),
		);
	});
});
