import { describe, expect, it } from "vitest";
import { createGoalProjection, type GoalState } from "../../src/projections/goal.ts";
import type { EventEnvelope } from "../../src/types.ts";

function makeEvent(
	type: string,
	payload: Record<string, unknown>,
	timestamp = "2025-01-01T00:00:00.000Z",
): EventEnvelope {
	return {
		id: `evt-${Math.random().toString(36).slice(2)}`,
		stream: "test",
		type,
		timestamp,
		sequence: 0,
		payload,
	};
}

describe("Goal projection", () => {
	it("goal_started transitions to running", () => {
		const proj = createGoalProjection();
		const initial =
			typeof proj.initialState === "function" ? (proj.initialState as () => GoalState)() : proj.initialState;

		const state1 = proj.reduce(initial, makeEvent("goal_started", { goalId: "g1", text: "refactor X" }));
		expect(state1.status).toBe("running");
		expect(state1.text).toBe("refactor X");
		expect(state1.goalId).toBe("g1");
		expect(state1.startedAt).not.toBeNull();

		const sigEvt = makeEvent("goal_started", { goalId: "g1", text: "refactor X" }, state1.startedAt!);
		const signals1 = proj.extractSignals!(state1, sigEvt);
		expect(signals1.length).toBe(1);
		expect(signals1[0].type).toBe("Goal/statusChanged");
		expect((signals1[0].payload as Record<string, unknown>).status).toBe("running");
		expect((signals1[0].payload as Record<string, unknown>).previous).toBe("pending");
	});

	it("goal_finished with success transitions to completed", () => {
		const proj = createGoalProjection();
		const initial =
			typeof proj.initialState === "function" ? (proj.initialState as () => GoalState)() : proj.initialState;

		const ts1 = "2025-01-01T00:00:00.000Z";
		const ts2 = "2025-01-01T00:00:01.000Z";
		const state1 = proj.reduce(initial, makeEvent("goal_started", { goalId: "g1", text: "refactor X" }, ts1));
		const finishedEvt = makeEvent("goal_finished", { success: true }, ts2);
		const state2 = proj.reduce(state1, finishedEvt);

		expect(state2.status).toBe("completed");
		expect(state2.finishedAt).toBe(ts2);
		expect(state2.reason).toBeNull();

		const signals = proj.extractSignals!(state2, finishedEvt);
		expect(signals.length).toBe(1);
		expect((signals[0].payload as Record<string, unknown>).status).toBe("completed");
		expect((signals[0].payload as Record<string, unknown>).previous).toBe("running");
	});

	it("goal_finished with failure transitions to incomplete", () => {
		const proj = createGoalProjection();
		const initial =
			typeof proj.initialState === "function" ? (proj.initialState as () => GoalState)() : proj.initialState;

		const ts1 = "2025-01-01T00:00:00.000Z";
		const ts2 = "2025-01-01T00:00:01.000Z";
		const state1 = proj.reduce(initial, makeEvent("goal_started", { goalId: "g1", text: "refactor X" }, ts1));
		const finishedEvt = makeEvent("goal_finished", { success: false, reason: "broke tests" }, ts2);
		const state2 = proj.reduce(state1, finishedEvt);

		expect(state2.status).toBe("incomplete");
		expect(state2.reason).toBe("broke tests");

		const signals = proj.extractSignals!(state2, finishedEvt);
		expect(signals.length).toBe(1);
		expect((signals[0].payload as Record<string, unknown>).status).toBe("incomplete");
		expect((signals[0].payload as Record<string, unknown>).previous).toBe("running");
	});
});
