import type { EventEnvelope, Signal } from "@piki/event-core";
import { describe, expect, it } from "vitest";
import {
	createWorkerActivityProjection,
	WorkerActivitySignals,
	type WorkerActivityState,
} from "../../src/projections/worker-activity.ts";

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

function makeProjection() {
	return createWorkerActivityProjection();
}

function initialState(): WorkerActivityState {
	const proj = makeProjection();
	return (proj.initialState as () => WorkerActivityState)();
}

function reduce(state: WorkerActivityState, event: EventEnvelope): WorkerActivityState {
	return makeProjection().reduce(state, event);
}

function extractSignals(state: WorkerActivityState, event: EventEnvelope): Signal[] {
	const proj = makeProjection();
	if (!proj.extractSignals) return [];
	return proj.extractSignals(state, event);
}

const T1 = "2025-01-01T00:00:00.000Z";
const T2 = "2025-01-01T00:00:01.000Z";
const T3 = "2025-01-01T00:00:02.000Z";
const T4 = "2025-01-01T00:00:03.000Z";
const T5 = "2025-01-01T00:00:04.000Z";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("WorkerActivity projection (reduce)", () => {
	it("starts with empty state", () => {
		const s = initialState();
		expect(s.entriesByParent.size).toBe(0);
		expect(s.seenCursorByParent.size).toBe(0);
		expect(s.pendingProse.size).toBe(0);
		expect(s.userMessageIdsByFork.size).toBe(0);
		expect(s.forkParent.size).toBe(0);
		expect(s.lastActivityTimestamp.size).toBe(0);
		expect(s.pendingSignals).toEqual([]);
	});

	describe("agent_created tracks parent fork", () => {
		it("stores parentForkId from agent_created payload", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }));

			expect(s1.forkParent.get("child-1")).toBe("leader-1");
		});

		it("stores null parentForkId when not present", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", { forkId: "leader-1" }));

			expect(s1.forkParent.get("leader-1")).toBeNull();
		});

		it("ignores agent_created without forkId", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("agent_created", {}));

			expect(s1.forkParent.size).toBe(0);
		});
	});

	describe("message_start / message_chunk accumulation", () => {
		it("tracks coordinator-bound message IDs", () => {
			const s0 = initialState();
			const s1 = reduce(
				s0,
				makeEvent("message_start", {
					forkId: "child-1",
					id: "msg-1",
					destination: { kind: "coordinator" },
				}),
			);

			expect(s1.userMessageIdsByFork.get("child-1")?.has("msg-1")).toBe(true);
		});

		it("ignores non-coordinator-bound messages", () => {
			const s0 = initialState();
			const s1 = reduce(
				s0,
				makeEvent("message_start", {
					forkId: "child-1",
					id: "msg-1",
					destination: { kind: "user" },
				}),
			);

			expect(s1.userMessageIdsByFork.size).toBe(0);
		});

		it("ignores message_start with null forkId", () => {
			const s0 = initialState();
			const s1 = reduce(
				s0,
				makeEvent("message_start", {
					id: "msg-1",
					destination: { kind: "coordinator" },
				}),
			);

			expect(s1.userMessageIdsByFork.size).toBe(0);
		});

		it("accumulates prose from message_chunk for tracked message ID", () => {
			let s = initialState();
			s = reduce(
				s,
				makeEvent("message_start", {
					forkId: "child-1",
					id: "msg-1",
					destination: { kind: "coordinator" },
				}),
			);
			s = reduce(s, makeEvent("message_chunk", { forkId: "child-1", id: "msg-1", text: "Hello " }));
			s = reduce(s, makeEvent("message_chunk", { forkId: "child-1", id: "msg-1", text: "world" }));

			expect(s.pendingProse.get("child-1")).toBe("Hello world");
		});

		it("ignores message_chunk for untracked message ID", () => {
			let s = initialState();
			s = reduce(
				s,
				makeEvent("message_start", {
					forkId: "child-1",
					id: "msg-1",
					destination: { kind: "coordinator" },
				}),
			);
			s = reduce(s, makeEvent("message_chunk", { forkId: "child-1", id: "msg-2", text: "ignored" }));

			expect(s.pendingProse.get("child-1")).toBeUndefined();
		});

		it("ignores message_chunk with null forkId", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("message_chunk", { id: "msg-1", text: "ignored" }));

			expect(s1.pendingProse.size).toBe(0);
		});

		it("accumulates prose across multiple message IDs for the same fork", () => {
			let s = initialState();
			s = reduce(
				s,
				makeEvent("message_start", {
					forkId: "child-1",
					id: "msg-1",
					destination: { kind: "coordinator" },
				}),
			);
			s = reduce(
				s,
				makeEvent("message_start", {
					forkId: "child-1",
					id: "msg-2",
					destination: { kind: "coordinator" },
				}),
			);
			s = reduce(s, makeEvent("message_chunk", { forkId: "child-1", id: "msg-1", text: "A" }));
			s = reduce(s, makeEvent("message_chunk", { forkId: "child-1", id: "msg-2", text: "B" }));

			expect(s.pendingProse.get("child-1")).toBe("AB");
		});
	});

	describe("turn_outcome creates activity entry for parent", () => {
		it("creates an entry with accumulated prose", () => {
			let s = initialState();
			// Set up parent-child relationship
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			// Track message and accumulate prose
			s = reduce(
				s,
				makeEvent(
					"message_start",
					{
						forkId: "child-1",
						id: "msg-1",
						destination: { kind: "coordinator" },
					},
					{ timestamp: T2 },
				),
			);
			s = reduce(
				s,
				makeEvent("message_chunk", { forkId: "child-1", id: "msg-1", text: "Task done" }, { timestamp: T2 }),
			);
			// Turn outcome
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T3 }));

			const entries = s.entriesByParent.get("leader-1") ?? [];
			expect(entries).toHaveLength(1);
			expect(entries[0]).toEqual({
				type: "turn_outcome",
				forkId: "child-1",
				text: "Task done",
				timestamp: T3,
			});
		});

		it("creates an entry without prose when no messages", () => {
			let s = initialState();
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T3 }));

			const entries = s.entriesByParent.get("leader-1") ?? [];
			expect(entries).toHaveLength(1);
			expect(entries[0]).toEqual({
				type: "turn_outcome",
				forkId: "child-1",
				text: undefined,
				timestamp: T3,
			});
		});

		it("updates lastActivityTimestamp for parent", () => {
			let s = initialState();
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T3 }));

			expect(s.lastActivityTimestamp.get("leader-1")).toBe(T3);
		});

		it("clears pending prose and message IDs for the fork", () => {
			let s = initialState();
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(
				s,
				makeEvent(
					"message_start",
					{
						forkId: "child-1",
						id: "msg-1",
						destination: { kind: "coordinator" },
					},
					{ timestamp: T1 },
				),
			);
			s = reduce(
				s,
				makeEvent("message_chunk", { forkId: "child-1", id: "msg-1", text: "prose" }, { timestamp: T2 }),
			);
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T3 }));

			expect(s.pendingProse.get("child-1")).toBeUndefined();
			expect(s.userMessageIdsByFork.get("child-1")).toBeUndefined();
		});

		it("ignores turn_outcome with null forkId", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("turn_outcome", { turnId: "turn-1" }, { timestamp: T1 }));

			expect(s1.entriesByParent.size).toBe(0);
		});

		it("ignores turn_outcome for unknown fork (no parent mapping)", () => {
			const s0 = initialState();
			const s1 = reduce(
				s0,
				makeEvent("turn_outcome", { forkId: "unknown-fork", turnId: "turn-1" }, { timestamp: T1 }),
			);

			expect(s1.entriesByParent.size).toBe(0);
		});

		it("accumulates multiple entries for the same parent", () => {
			let s = initialState();
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("agent_created", { forkId: "child-2", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T2 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-2", turnId: "turn-2" }, { timestamp: T3 }));

			const entries = s.entriesByParent.get("leader-1") ?? [];
			expect(entries).toHaveLength(2);
			expect(entries[0].forkId).toBe("child-1");
			expect(entries[1].forkId).toBe("child-2");
		});
	});

	describe("turn_started / unseen activity signal", () => {
		it("emits signal when turn_started has unseen entries", () => {
			let s = initialState();
			// Create activity first
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T2 }));

			// turn_started for the parent fork should trigger signal
			const event = makeEvent("turn_started", { forkId: "leader-1" }, { timestamp: T3 });
			const s2 = reduce(s, event);
			const signals = extractSignals(s2, event);

			expect(signals).toHaveLength(1);
			expect(signals[0].type).toBe(WorkerActivitySignals.unseenActivityAvailable.type);
			expect(signals[0].payload).toEqual(
				expect.objectContaining({
					parentForkId: "leader-1",
					entries: expect.arrayContaining([expect.objectContaining({ forkId: "child-1", type: "turn_outcome" })]),
				}),
			);
		});

		it("advances cursor after emitting signal", () => {
			let s = initialState();
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T2 }));

			const event = makeEvent("turn_started", { forkId: "leader-1" }, { timestamp: T3 });
			const s2 = reduce(s, event);

			expect(s2.seenCursorByParent.get("leader-1")).toBe(1);
		});

		it("does not re-emit already-seen entries", () => {
			let s = initialState();
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T2 }));

			// First turn_started emits
			const event1 = makeEvent("turn_started", { forkId: "leader-1" }, { timestamp: T3 });
			s = reduce(s, event1);

			// Second turn_started without new entries — no signal
			const event2 = makeEvent("turn_started", { forkId: "leader-1" }, { timestamp: T4 });
			const s2 = reduce(s, event2);
			const signals = extractSignals(s2, event2);

			expect(signals).toHaveLength(0);
			expect(s2.seenCursorByParent.get("leader-1")).toBe(1);
		});

		it("emits only new entries since last seen cursor", () => {
			let s = initialState();
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T2 }));

			// First turn_started emits entry 1
			const event1 = makeEvent("turn_started", { forkId: "leader-1" }, { timestamp: T3 });
			s = reduce(s, event1);

			// Add another entry
			s = reduce(s, makeEvent("agent_created", { forkId: "child-2", parentForkId: "leader-1" }, { timestamp: T3 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-2", turnId: "turn-2" }, { timestamp: T4 }));

			// Second turn_started should emit only entry 2
			const event2 = makeEvent("turn_started", { forkId: "leader-1" }, { timestamp: T5 });
			const s2 = reduce(s, event2);
			const signals = extractSignals(s2, event2);

			expect(signals).toHaveLength(1);
			expect(signals[0].payload).toEqual(
				expect.objectContaining({
					parentForkId: "leader-1",
					entries: [expect.objectContaining({ forkId: "child-2" })],
				}),
			);
			expect(s2.seenCursorByParent.get("leader-1")).toBe(2);
		});

		it("no signal when no unseen entries exist", () => {
			const s0 = initialState();
			const event = makeEvent("turn_started", { forkId: "leader-1" }, { timestamp: T1 });
			const s1 = reduce(s0, event);
			const signals = extractSignals(s1, event);

			expect(signals).toHaveLength(0);
		});

		it("ignores turn_started with null forkId", () => {
			const s0 = initialState();
			const event = makeEvent("turn_started", {}, { timestamp: T1 });
			const s1 = reduce(s0, event);

			expect(s1).toEqual(initialState());
		});
	});

	describe("agent_killed clears pending state", () => {
		it("clears pendingProse and userMessageIdsByFork on agent_killed", () => {
			let s = initialState();
			s = reduce(
				s,
				makeEvent(
					"message_start",
					{
						forkId: "child-1",
						id: "msg-1",
						destination: { kind: "coordinator" },
					},
					{ timestamp: T1 },
				),
			);
			s = reduce(
				s,
				makeEvent("message_chunk", { forkId: "child-1", id: "msg-1", text: "prose" }, { timestamp: T2 }),
			);

			s = reduce(s, makeEvent("agent_killed", { forkId: "child-1" }, { timestamp: T3 }));

			expect(s.pendingProse.get("child-1")).toBeUndefined();
			expect(s.userMessageIdsByFork.get("child-1")).toBeUndefined();
		});

		it("clears pendingProse and userMessageIdsByFork on subagent_user_killed", () => {
			let s = initialState();
			s = reduce(
				s,
				makeEvent(
					"message_start",
					{
						forkId: "child-1",
						id: "msg-1",
						destination: { kind: "coordinator" },
					},
					{ timestamp: T1 },
				),
			);
			s = reduce(
				s,
				makeEvent("message_chunk", { forkId: "child-1", id: "msg-1", text: "prose" }, { timestamp: T2 }),
			);

			s = reduce(s, makeEvent("subagent_user_killed", { forkId: "child-1" }, { timestamp: T3 }));

			expect(s.pendingProse.get("child-1")).toBeUndefined();
			expect(s.userMessageIdsByFork.get("child-1")).toBeUndefined();
		});

		it("clears pendingProse and userMessageIdsByFork on worker_idle_closed", () => {
			let s = initialState();
			s = reduce(
				s,
				makeEvent(
					"message_start",
					{
						forkId: "child-1",
						id: "msg-1",
						destination: { kind: "coordinator" },
					},
					{ timestamp: T1 },
				),
			);
			s = reduce(
				s,
				makeEvent("message_chunk", { forkId: "child-1", id: "msg-1", text: "prose" }, { timestamp: T2 }),
			);

			s = reduce(s, makeEvent("worker_idle_closed", { forkId: "child-1" }, { timestamp: T3 }));

			expect(s.pendingProse.get("child-1")).toBeUndefined();
			expect(s.userMessageIdsByFork.get("child-1")).toBeUndefined();
		});

		it("preserves committed entries (entriesByParent) after agent_killed", () => {
			let s = initialState();
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T2 }));
			s = reduce(s, makeEvent("agent_killed", { forkId: "child-1" }, { timestamp: T3 }));

			// entriesByParent is preserved (not cleared by agent_killed)
			const entries = s.entriesByParent.get("leader-1") ?? [];
			expect(entries).toHaveLength(1);
		});
	});

	describe("pendingSignals lifecycle", () => {
		it("pendingSignals is cleared on next reduce call", () => {
			let s = initialState();
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T2 }));

			// turn_started sets pendingSignals
			const event = makeEvent("turn_started", { forkId: "leader-1" }, { timestamp: T3 });
			s = reduce(s, event);
			expect(s.pendingSignals).toHaveLength(1);

			// Next event clears pendingSignals
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-2" }, { timestamp: T4 }));
			expect(s.pendingSignals).toHaveLength(0);
		});

		it("extractSignals returns pending signals", () => {
			let s = initialState();
			s = reduce(s, makeEvent("agent_created", { forkId: "child-1", parentForkId: "leader-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T2 }));

			const event = makeEvent("turn_started", { forkId: "leader-1" }, { timestamp: T3 });
			const s2 = reduce(s, event);
			const signals = extractSignals(s2, event);

			expect(signals).toHaveLength(1);
			expect(signals[0].type).toBe("SubagentActivity/unseenActivityAvailable");
		});

		it("extractSignals returns empty when no pending signals", () => {
			const s0 = initialState();
			const event = makeEvent("turn_outcome", { forkId: "child-1", turnId: "turn-1" }, { timestamp: T1 });
			const signals = extractSignals(s0, event);

			expect(signals).toHaveLength(0);
		});
	});

	describe("unknown event types", () => {
		it("leaves state unchanged for unrecognized event types", () => {
			const s0 = initialState();
			const s1 = reduce(s0, makeEvent("some_random_event", { forkId: "fork-1" }, { timestamp: T1 }));

			expect(s1).toEqual(s0);
		});
	});

	describe("multiple forks are independent", () => {
		it("tracks entries independently per parent fork", () => {
			let s = initialState();
			s = reduce(s, makeEvent("agent_created", { forkId: "child-a", parentForkId: "parent-1" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("agent_created", { forkId: "child-b", parentForkId: "parent-2" }, { timestamp: T1 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-a", turnId: "turn-a" }, { timestamp: T2 }));
			s = reduce(s, makeEvent("turn_outcome", { forkId: "child-b", turnId: "turn-b" }, { timestamp: T3 }));

			const entries1 = s.entriesByParent.get("parent-1") ?? [];
			const entries2 = s.entriesByParent.get("parent-2") ?? [];

			expect(entries1).toHaveLength(1);
			expect(entries1[0].forkId).toBe("child-a");
			expect(entries2).toHaveLength(1);
			expect(entries2[0].forkId).toBe("child-b");
		});
	});
});
