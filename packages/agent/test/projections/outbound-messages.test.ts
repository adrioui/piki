import type { EventEnvelope } from "@piki/event-core";
import { ProjectionStore } from "@piki/event-core";
import { describe, expect, it } from "vitest";
import {
	createOutboundMessagesProjection,
	type OutboundMessagesState,
} from "../../src/projections/outbound-messages.ts";

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

function getState(store: ProjectionStore<EventEnvelope>): OutboundMessagesState {
	return store.get<OutboundMessagesState>("OutboundMessages")!;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("OutboundMessages projection", () => {
	function createStore(): ProjectionStore<EventEnvelope> {
		const store = new ProjectionStore<EventEnvelope>();
		store.register(createOutboundMessagesProjection());
		return store;
	}

	describe("text accumulation across chunks", () => {
		it("accumulates text from multiple message_chunk events", () => {
			const store = createStore();
			store.apply(makeEvent("message_start", { id: "msg-1", forkId: "f-main", destination: { kind: "user" } }));
			store.apply(makeEvent("message_chunk", { id: "msg-1", text: "Hello " }));
			store.apply(makeEvent("message_chunk", { id: "msg-1", text: "world" }));
			store.apply(makeEvent("message_chunk", { id: "msg-1", text: "!" }));

			const state = getState(store);
			expect(state.pendingMessages["msg-1"]).toBeDefined();
			expect(state.pendingMessages["msg-1"].text).toBe("Hello world!");
		});

		it("ignores chunks for unknown message ids", () => {
			const store = createStore();
			store.apply(makeEvent("message_chunk", { id: "unknown", text: "ignored" }));

			const state = getState(store);
			expect(state.pendingMessages.unknown).toBeUndefined();
		});
	});

	describe("signal emission on message_end", () => {
		it("emits messageCompleted signal with accumulated text", () => {
			const store = createStore();
			store.apply(makeEvent("message_start", { id: "msg-1", forkId: "f-main", destination: { kind: "user" } }));
			store.apply(makeEvent("message_chunk", { id: "msg-1", text: "Hello " }));
			const signals = store.apply(
				makeEvent("message_end", { id: "msg-1" }, { timestamp: "2025-01-01T00:00:10.000Z" }),
			);

			expect(signals).toHaveLength(1);
			expect(signals[0].type).toBe("OutboundMessages/messageCompleted");
			expect(signals[0].payload).toMatchObject({
				id: "msg-1",
				forkId: "f-main",
				text: "Hello ",
				targetForkId: null,
				userFacing: true,
				timestamp: "2025-01-01T00:00:10.000Z",
			});
		});

		it("does not emit signal for unknown message_end", () => {
			const store = createStore();
			const signals = store.apply(makeEvent("message_end", { id: "unknown" }));
			expect(signals).toHaveLength(0);
		});

		it("cleans up pending entry after message_end", () => {
			const store = createStore();
			store.apply(makeEvent("message_start", { id: "msg-1", forkId: "f-main", destination: { kind: "user" } }));
			store.apply(makeEvent("message_end", { id: "msg-1" }));

			const state = getState(store);
			expect(state.pendingMessages["msg-1"]).toBeUndefined();
		});
	});

	describe("user destination routing", () => {
		it("sets targetForkId to null and userFacing to true", () => {
			const store = createStore();
			store.apply(
				makeEvent("message_start", {
					id: "msg-u",
					forkId: "f-worker",
					destination: { kind: "user" },
				}),
			);
			store.apply(makeEvent("message_chunk", { id: "msg-u", text: "result" }));
			const signals = store.apply(makeEvent("message_end", { id: "msg-u" }, { timestamp: "T1" }));

			expect(signals[0].payload).toMatchObject({
				targetForkId: null,
				userFacing: true,
			});
		});
	});

	describe("coordinator destination routing", () => {
		it("sets targetForkId to parentForkId from forkParentMap", () => {
			const store = createStore();

			// Seed routing: parent fork f-main spawns child fork f-worker
			store.apply(
				makeEvent("agent_created", {
					forkId: "f-main",
					agentId: "leader",
				}),
			);
			store.apply(
				makeEvent("agent_created", {
					forkId: "f-worker",
					agentId: "worker-1",
					parentForkId: "f-main",
				}),
			);

			// Send a message from worker to coordinator
			store.apply(
				makeEvent("message_start", {
					id: "msg-c",
					forkId: "f-worker",
					destination: { kind: "coordinator" },
				}),
			);
			store.apply(makeEvent("message_chunk", { id: "msg-c", text: "done" }));
			const signals = store.apply(makeEvent("message_end", { id: "msg-c" }, { timestamp: "T2" }));

			expect(signals[0].payload).toMatchObject({
				targetForkId: "f-main",
				userFacing: false,
			});
		});

		it("returns null targetForkId when forkId has no parent", () => {
			const store = createStore();
			store.apply(
				makeEvent("message_start", {
					id: "msg-c2",
					forkId: "f-orphan",
					destination: { kind: "coordinator" },
				}),
			);
			store.apply(makeEvent("message_chunk", { id: "msg-c2", text: "ping" }));
			const signals = store.apply(makeEvent("message_end", { id: "msg-c2" }, { timestamp: "T3" }));

			expect(signals[0].payload).toMatchObject({
				targetForkId: null,
				userFacing: false,
			});
		});

		it("returns null targetForkId when message has null forkId", () => {
			const store = createStore();
			store.apply(
				makeEvent("message_start", {
					id: "msg-c3",
					forkId: null,
					destination: { kind: "coordinator" },
				}),
			);
			store.apply(makeEvent("message_chunk", { id: "msg-c3", text: "ping" }));
			const signals = store.apply(makeEvent("message_end", { id: "msg-c3" }, { timestamp: "T4" }));

			expect(signals[0].payload).toMatchObject({
				targetForkId: null,
				userFacing: false,
			});
		});
	});

	describe("worker destination routing", () => {
		it("sets targetForkId via agentId lookup in agentForkMap", () => {
			const store = createStore();

			// Seed routing: worker agent created
			store.apply(
				makeEvent("agent_created", {
					forkId: "f-critic",
					agentId: "critic-1",
					parentForkId: "f-main",
				}),
			);

			// Send a message addressed to worker "critic-1"
			store.apply(
				makeEvent("message_start", {
					id: "msg-w",
					forkId: "f-main",
					destination: { kind: "worker", agentId: "critic-1" },
				}),
			);
			store.apply(makeEvent("message_chunk", { id: "msg-w", text: "review this" }));
			const signals = store.apply(makeEvent("message_end", { id: "msg-w" }, { timestamp: "T5" }));

			expect(signals[0].payload).toMatchObject({
				targetForkId: "f-critic",
				userFacing: false,
			});
		});

		it("returns null targetForkId when agentId is unknown", () => {
			const store = createStore();
			store.apply(
				makeEvent("message_start", {
					id: "msg-w2",
					forkId: "f-main",
					destination: { kind: "worker", agentId: "unknown-agent" },
				}),
			);
			store.apply(makeEvent("message_chunk", { id: "msg-w2", text: "hello" }));
			const signals = store.apply(makeEvent("message_end", { id: "msg-w2" }, { timestamp: "T6" }));

			expect(signals[0].payload).toMatchObject({
				targetForkId: null,
				userFacing: false,
			});
		});
	});

	describe("multiple concurrent messages", () => {
		it("tracks independent messages and emits signals for each on message_end", () => {
			const store = createStore();
			store.apply(makeEvent("agent_created", { forkId: "f-w", agentId: "w1", parentForkId: "f-main" }));

			store.apply(makeEvent("message_start", { id: "msg-a", forkId: "f-main", destination: { kind: "user" } }));
			store.apply(makeEvent("message_start", { id: "msg-b", forkId: "f-w", destination: { kind: "coordinator" } }));
			store.apply(makeEvent("message_chunk", { id: "msg-a", text: "chunk-a1" }));
			store.apply(makeEvent("message_chunk", { id: "msg-b", text: "chunk-b1" }));
			store.apply(makeEvent("message_chunk", { id: "msg-a", text: "chunk-a2" }));

			const signalsB = store.apply(makeEvent("message_end", { id: "msg-b" }, { timestamp: "TB" }));
			expect(signalsB).toHaveLength(1);
			expect(signalsB[0].payload).toMatchObject({
				id: "msg-b",
				text: "chunk-b1",
				targetForkId: "f-main",
			});

			// msg-a should still be pending
			expect(getState(store).pendingMessages["msg-a"]).toBeDefined();
			expect(getState(store).pendingMessages["msg-a"].text).toBe("chunk-a1chunk-a2");

			const signalsA = store.apply(makeEvent("message_end", { id: "msg-a" }, { timestamp: "TA" }));
			expect(signalsA).toHaveLength(1);
			expect(signalsA[0].payload).toMatchObject({
				id: "msg-a",
				text: "chunk-a1chunk-a2",
				userFacing: true,
			});
		});
	});

	describe("agent_created builds routing maps", () => {
		it("populates forkParentMap and agentForkMap", () => {
			const store = createStore();
			store.apply(
				makeEvent("agent_created", {
					forkId: "f-leader",
					agentId: "leader",
				}),
			);
			store.apply(
				makeEvent("agent_created", {
					forkId: "f-w1",
					agentId: "worker-1",
					parentForkId: "f-leader",
				}),
			);

			const state = getState(store);
			expect(state.forkParentMap["f-leader"]).toBeNull();
			expect(state.forkParentMap["f-w1"]).toBe("f-leader");
			expect(state.agentForkMap.leader).toBe("f-leader");
			expect(state.agentForkMap["worker-1"]).toBe("f-w1");
		});

		it("defaults forkId to agentId when forkId is absent", () => {
			const store = createStore();
			store.apply(makeEvent("agent_created", { agentId: "solo-agent" }));

			const state = getState(store);
			expect(state.agentForkMap["solo-agent"]).toBe("solo-agent");
			expect(state.forkParentMap["solo-agent"]).toBeNull();
		});
	});
});
