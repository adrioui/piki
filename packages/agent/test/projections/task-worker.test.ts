import type { EventEnvelope } from "@piki/event-core";
import { describe, expect, it } from "vitest";
import { createTaskWorkerProjection, type TaskWorkerState } from "../../src/projections/task-worker.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(
	type: string,
	payload: Record<string, unknown> = {},
	overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
	return {
		id: `evt-${Math.random().toString(36).slice(2, 10)}`,
		stream: "test",
		sequence: 0,
		type,
		timestamp: new Date().toISOString(),
		payload,
		...overrides,
	};
}

function initialState(): TaskWorkerState {
	const proj = createTaskWorkerProjection();
	const init =
		typeof proj.initialState === "function" ? (proj.initialState as () => TaskWorkerState)() : proj.initialState;
	return init;
}

function reduce(state: TaskWorkerState, event: EventEnvelope): TaskWorkerState {
	const proj = createTaskWorkerProjection();
	return proj.reduce(state, event);
}

const T1 = "2025-01-01T00:00:00.000Z";
const T2 = "2025-01-01T00:00:01.000Z";
const T3 = "2025-01-01T00:00:02.000Z";
const T4 = "2025-01-01T00:00:03.000Z";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("TaskWorker projection (reduce)", () => {
	it("starts with empty activity", () => {
		const s = initialState();
		expect(s.workerActivityByForkId).toEqual({});
		expect(s.orderedTaskIds).toEqual([]);
		expect(s.snapshots).toEqual({});
	});

	describe("activity lifecycle: agent_created → turn_started → turn_outcome", () => {
		it("creates activity entry on agent_created", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));

			expect(s1.workerActivityByForkId["fork-1"]).toEqual({
				forkId: "fork-1",
				activeSince: null,
				accumulatedMs: 0,
				completedAt: null,
				resumeCount: 0,
			});
		});

		it("marks working on turn_started", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("turn_started", { forkId: "fork-1" }, { timestamp: T2 }));

			expect(s2.workerActivityByForkId["fork-1"].activeSince).toBe(T2);
		});

		it("marks idle on turn_outcome and accumulates time", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("turn_started", { forkId: "fork-1" }, { timestamp: T2 }));
			const s3 = reduce(s2, makeEvent("turn_outcome", { forkId: "fork-1", outcome: "stop" }, { timestamp: T3 }));

			const entry = s3.workerActivityByForkId["fork-1"];
			expect(entry.activeSince).toBeNull();
			expect(entry.completedAt).toBe(T3);
			expect(entry.accumulatedMs).toBe(1000); // T3 - T2 = 1s
		});

		it("removes activity on agent_finished", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("agent_finished", { forkId: "fork-1" }, { timestamp: T2 }));

			expect(s2.workerActivityByForkId["fork-1"]).toBeUndefined();
		});
	});

	describe("forkId === null guard", () => {
		it("turn_started with null forkId leaves state unchanged", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("turn_started", {}, { timestamp: T1 }));

			expect(s1).toEqual(s0);
		});

		it("turn_outcome with null forkId leaves state unchanged", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("turn_outcome", { outcome: "stop" }, { timestamp: T1 }));

			expect(s1).toEqual(s0);
		});

		it("interrupt with null forkId leaves state unchanged", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("interrupt", {}, { timestamp: T1 }));

			expect(s1).toEqual(s0);
		});
	});

	describe("resume + remove lifecycle", () => {
		it("increments resumeCount on reactivation after idle", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("turn_started", { forkId: "fork-1" }, { timestamp: T2 }));

			// First idle
			const s3 = reduce(s2, makeEvent("turn_outcome", { forkId: "fork-1", outcome: "stop" }, { timestamp: T3 }));
			expect(s3.workerActivityByForkId["fork-1"].resumeCount).toBe(0);

			// Resume → re-enter working state → resumeCount increments
			const s4 = reduce(s3, makeEvent("turn_started", { forkId: "fork-1" }, { timestamp: T4 }));
			expect(s4.workerActivityByForkId["fork-1"].activeSince).toBe(T4);
			expect(s4.workerActivityByForkId["fork-1"].resumeCount).toBe(1);

			// Accumulated time carries over from previous session
			expect(s4.workerActivityByForkId["fork-1"].accumulatedMs).toBe(1000);
		});

		it("agent_killed removes the activity entry", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("turn_started", { forkId: "fork-1" }, { timestamp: T2 }));
			const s3 = reduce(s2, makeEvent("agent_killed", { forkId: "fork-1" }, { timestamp: T3 }));

			expect(s3.workerActivityByForkId["fork-1"]).toBeUndefined();
		});

		it("subagent_user_killed removes the activity entry", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-2" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("subagent_user_killed", { forkId: "fork-2" }, { timestamp: T2 }));

			expect(s2.workerActivityByForkId["fork-2"]).toBeUndefined();
		});

		it("worker_idle_closed removes the activity entry", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-3" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("worker_idle_closed", { forkId: "fork-3" }, { timestamp: T2 }));

			expect(s2.workerActivityByForkId["fork-3"]).toBeUndefined();
		});
	});

	describe("chaining turn_outcome does NOT mark idle", () => {
		it("outcome 'continue' keeps worker active (no idle transition)", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("turn_started", { forkId: "fork-1" }, { timestamp: T2 }));
			const s3 = reduce(s2, makeEvent("turn_outcome", { forkId: "fork-1", outcome: "continue" }, { timestamp: T3 }));

			// State should be unchanged because outcome chains
			expect(s3).toEqual(s2);
		});

		it("outcome 'chain' keeps worker active", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("turn_started", { forkId: "fork-1" }, { timestamp: T2 }));
			const s3 = reduce(s2, makeEvent("turn_outcome", { forkId: "fork-1", outcome: "chain" }, { timestamp: T3 }));

			expect(s3).toEqual(s2);
		});

		it("outcome 'chaining' keeps worker active", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("turn_started", { forkId: "fork-1" }, { timestamp: T2 }));
			const s3 = reduce(s2, makeEvent("turn_outcome", { forkId: "fork-1", outcome: "chaining" }, { timestamp: T3 }));

			expect(s3).toEqual(s2);
		});

		it("outcome with chaining:true object keeps worker active", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("turn_started", { forkId: "fork-1" }, { timestamp: T2 }));
			const s3 = reduce(
				s2,
				makeEvent("turn_outcome", { forkId: "fork-1", outcome: { chaining: true } }, { timestamp: T3 }),
			);

			expect(s3).toEqual(s2);
		});

		it("outcome with willContinue:true keeps worker active", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("turn_started", { forkId: "fork-1" }, { timestamp: T2 }));
			const s3 = reduce(
				s2,
				makeEvent("turn_outcome", { forkId: "fork-1", outcome: { willContinue: true } }, { timestamp: T3 }),
			);

			expect(s3).toEqual(s2);
		});
	});

	describe("unknown event type", () => {
		it("leaves state unchanged for unrecognized event types", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("some_random_event", { forkId: "fork-1" }, { timestamp: T2 }));

			expect(s2).toEqual(s1);
		});
	});

	describe("agent_created with no forkId uses MAIN sentinel", () => {
		it("uses __main__ sentinel when forkId is missing", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", {}, { timestamp: T1 }));

			expect(s1.workerActivityByForkId.__main__).toBeDefined();
			expect(s1.workerActivityByForkId.__main__.forkId).toBe("__main__");
		});
	});

	describe("interrupt marks idle", () => {
		it("marks worker idle on interrupt", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-1" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("turn_started", { forkId: "fork-1" }, { timestamp: T2 }));
			const s3 = reduce(s2, makeEvent("interrupt", { forkId: "fork-1" }, { timestamp: T3 }));

			const entry = s3.workerActivityByForkId["fork-1"];
			expect(entry.activeSince).toBeNull();
			expect(entry.completedAt).toBe(T3);
			expect(entry.accumulatedMs).toBe(1000);
		});
	});

	describe("multiple forks are independent", () => {
		it("tracks activity independently per fork", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "fork-a" }, { timestamp: T1 }));
			const s2 = reduce(s1, makeEvent("agent_created", { forkId: "fork-b" }, { timestamp: T1 }));
			const s3 = reduce(s2, makeEvent("turn_started", { forkId: "fork-a" }, { timestamp: T2 }));

			expect(s3.workerActivityByForkId["fork-a"].activeSince).toBe(T2);
			expect(s3.workerActivityByForkId["fork-b"].activeSince).toBeNull();

			const s4 = reduce(s3, makeEvent("turn_outcome", { forkId: "fork-a", outcome: "stop" }, { timestamp: T3 }));

			expect(s4.workerActivityByForkId["fork-a"].activeSince).toBeNull();
			expect(s4.workerActivityByForkId["fork-a"].accumulatedMs).toBe(1000);
			expect(s4.workerActivityByForkId["fork-b"].accumulatedMs).toBe(0);
		});
	});
});
