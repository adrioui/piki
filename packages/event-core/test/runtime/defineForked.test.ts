// packages/event-core/test/runtime/defineForked.test.ts
// Tests for defineForked — per-fork fiber lifecycle management.

import { Context, Effect, type Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { EventEnvelope, Signal } from "../../src/types.ts";
import { defineForked } from "../../src/worker/defineForked.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
	type: string,
	payload: Record<string, unknown> = {},
	overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
	return {
		id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		stream: "test",
		sequence: 1,
		type,
		timestamp: new Date().toISOString(),
		payload,
		...overrides,
	};
}

function makeSignal(type: string, payload: Record<string, unknown> = {}): Signal {
	return { type, payload };
}

/** Run an Effect with a provided layer, casting away remaining requirements. */
function runWithLayer<A>(effect: Effect.Effect<A, any, any>, layer: Layer.Layer<any, any, any>): Promise<A> {
	return Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("defineForked", () => {
	it("G8-T1 — fork spawns on activateOn event and handler receives events", async () => {
		const handled: Array<{ forkId: string; eventType: string }> = [];
		const _processed: string[] = [];

		const { Tag, Layer } = defineForked({
			name: "TestWorker",
			eventHandlers: {
				task_started: (event, _publish, _read) =>
					Effect.sync(() => {
						const forkId = ((event.payload as Record<string, unknown>).forkId as string) ?? "__main__";
						handled.push({ forkId, eventType: event.type });
					}),
			},
			forkLifecycle: {
				activateOn: "agent_created",
				completeOn: "agent_finished",
			},
		});

		await runWithLayer(
			Effect.gen(function* () {
				const worker = yield* Tag;

				// Activate a fork
				yield* worker.processEvent(makeEvent("agent_created", { forkId: "fork-1" }));

				// Verify fork is active
				const ids = yield* worker.activeForkIds;
				expect(ids).toContain("fork-1");
				expect(ids).toContain("__main__");

				// Send handler event to the fork
				yield* worker.processEvent(makeEvent("task_started", { forkId: "fork-1" }));

				// Give the fiber a tick to process the queued event
				yield* Effect.sleep("10 millis");

				expect(handled).toHaveLength(1);
				expect(handled[0]).toEqual({ forkId: "fork-1", eventType: "task_started" });
			}),
			Layer,
		);
	});

	it("G8-T2 — fork completes on completeOn event and is removed", async () => {
		const { Tag, Layer } = defineForked({
			name: "CompleteWorker",
			eventHandlers: {
				task_started: () => Effect.void,
			},
			forkLifecycle: {
				activateOn: "agent_created",
				completeOn: "agent_finished",
			},
		});

		await runWithLayer(
			Effect.gen(function* () {
				const worker = yield* Tag;

				// Spawn a fork
				yield* worker.processEvent(makeEvent("agent_created", { forkId: "fork-A" }));
				let ids = yield* worker.activeForkIds;
				expect(ids).toContain("fork-A");

				// Complete the fork
				yield* worker.processEvent(makeEvent("agent_finished", { forkId: "fork-A" }));
				ids = yield* worker.activeForkIds;
				expect(ids).not.toContain("fork-A");
				// Main fork still alive
				expect(ids).toContain("__main__");
			}),
			Layer,
		);
	});

	it("G8-T3 — signal handlers resolve correct forkId", async () => {
		const signalCalls: Array<{ signal: string; payload: unknown }> = [];

		const { Tag, Layer } = defineForked({
			name: "SignalWorker",
			forkLifecycle: {
				activateOn: "agent_created",
				completeOn: "agent_finished",
			},
			signalHandlers: (on) => [
				on(
					{ name: "TaskGraph/taskCreated", tag: Context.GenericTag<unknown>("TaskGraph/taskCreated") },
					(value, _publish, _read) =>
						Effect.sync(() => {
							signalCalls.push({ signal: "TaskGraph/taskCreated", payload: value });
						}),
				),
			],
		});

		await runWithLayer(
			Effect.gen(function* () {
				const worker = yield* Tag;

				// Send a signal with a forkId
				yield* worker.processSignal(makeSignal("TaskGraph/taskCreated", { forkId: "fork-7", taskId: "t1" }));

				expect(signalCalls).toHaveLength(1);
				expect(signalCalls[0].signal).toBe("TaskGraph/taskCreated");
				expect((signalCalls[0].payload as Record<string, unknown>).forkId).toBe("fork-7");

				// Send a signal without forkId — goes to __main__
				yield* worker.processSignal(makeSignal("TaskGraph/taskCreated", { taskId: "t2" }));

				expect(signalCalls).toHaveLength(2);
			}),
			Layer,
		);
	});

	it("G8-T4 — multiple forks managed independently", async () => {
		const handled: Array<{ forkId: string; eventType: string }> = [];

		const { Tag, Layer } = defineForked({
			name: "MultiForkWorker",
			eventHandlers: {
				task_event: (event, _publish, _read) =>
					Effect.sync(() => {
						const forkId = ((event.payload as Record<string, unknown>).forkId as string) ?? "__main__";
						handled.push({ forkId, eventType: event.type });
					}),
			},
			forkLifecycle: {
				activateOn: "agent_created",
				completeOn: "agent_finished",
			},
		});

		await runWithLayer(
			Effect.gen(function* () {
				const worker = yield* Tag;

				// Spawn two forks
				yield* worker.processEvent(makeEvent("agent_created", { forkId: "fork-X" }));
				yield* worker.processEvent(makeEvent("agent_created", { forkId: "fork-Y" }));

				const ids = yield* worker.activeForkIds;
				expect(ids).toContain("fork-X");
				expect(ids).toContain("fork-Y");
				expect(ids).toContain("__main__");

				// Send events to each fork
				yield* worker.processEvent(makeEvent("task_event", { forkId: "fork-X" }));
				yield* worker.processEvent(makeEvent("task_event", { forkId: "fork-Y" }));
				yield* worker.processEvent(makeEvent("task_event", { forkId: "fork-X" }));

				// Give fibers time to drain queues
				yield* Effect.sleep("50 millis");

				const xEvents = handled.filter((h) => h.forkId === "fork-X");
				const yEvents = handled.filter((h) => h.forkId === "fork-Y");
				expect(xEvents).toHaveLength(2);
				expect(yEvents).toHaveLength(1);

				// Complete fork-X only
				yield* worker.processEvent(makeEvent("agent_finished", { forkId: "fork-X" }));
				const afterIds = yield* worker.activeForkIds;
				expect(afterIds).not.toContain("fork-X");
				expect(afterIds).toContain("fork-Y");
			}),
			Layer,
		);
	});

	it("G8-T5 — duplicate activateOn does not spawn a second fiber", async () => {
		const { Tag, Layer } = defineForked({
			name: "DedupWorker",
			eventHandlers: {},
			forkLifecycle: {
				activateOn: "agent_created",
				completeOn: "agent_finished",
			},
		});

		await runWithLayer(
			Effect.gen(function* () {
				const worker = yield* Tag;

				yield* worker.processEvent(makeEvent("agent_created", { forkId: "fork-dup" }));
				yield* worker.processEvent(makeEvent("agent_created", { forkId: "fork-dup" }));

				const ids = yield* worker.activeForkIds;
				const dupCount = ids.filter((id: string) => id === "fork-dup").length;
				expect(dupCount).toBe(1);
			}),
			Layer,
		);
	});

	it("G8-T6 — activateOn and completeOn accept arrays", async () => {
		const { Tag, Layer } = defineForked({
			name: "ArrayLifecycleWorker",
			eventHandlers: {},
			forkLifecycle: {
				activateOn: ["worker_spawned", "worker_resumed"],
				completeOn: ["worker_done", "worker_killed"],
			},
		});

		await runWithLayer(
			Effect.gen(function* () {
				const worker = yield* Tag;

				// Spawn via first activate type
				yield* worker.processEvent(makeEvent("worker_spawned", { forkId: "arr-1" }));
				let ids = yield* worker.activeForkIds;
				expect(ids).toContain("arr-1");

				// Spawn via second activate type
				yield* worker.processEvent(makeEvent("worker_resumed", { forkId: "arr-2" }));
				ids = yield* worker.activeForkIds;
				expect(ids).toContain("arr-2");

				// Complete via first complete type
				yield* worker.processEvent(makeEvent("worker_done", { forkId: "arr-1" }));
				ids = yield* worker.activeForkIds;
				expect(ids).not.toContain("arr-1");
				expect(ids).toContain("arr-2");

				// Complete via second complete type
				yield* worker.processEvent(makeEvent("worker_killed", { forkId: "arr-2" }));
				ids = yield* worker.activeForkIds;
				expect(ids).not.toContain("arr-2");
			}),
			Layer,
		);
	});
});
