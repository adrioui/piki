import { describe, expect, it } from "vitest";
import {
	createUserMessageResolutionProjection,
	UserMessageResolutionSignals,
	type UserMessageResolutionState,
} from "../../src/projections/user-message-resolution.ts";
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

function getInitial(proj: ReturnType<typeof createUserMessageResolutionProjection>): UserMessageResolutionState {
	return typeof proj.initialState === "function"
		? (proj.initialState as () => UserMessageResolutionState)()
		: proj.initialState;
}

describe("UserMessageResolution projection", () => {
	it("received → resolved via turn_outcome", () => {
		const proj = createUserMessageResolutionProjection();
		const initial = getInitial(proj);

		const s1 = proj.reduce(initial, makeEvent("user_message", { messageId: "m1", text: "hi" }));
		expect(s1.messages.m1.status).toBe("pending");
		expect(s1.activeMessageId).toBe("m1");
		expect(s1.pendingIds.length).toBe(1);

		const ts2 = "2025-01-01T00:00:01.000Z";
		const s2 = proj.reduce(s1, makeEvent("turn_outcome", {}, ts2));
		expect(s2.messages.m1.status).toBe("resolved");
		expect(s2.messages.m1.resolvedAt).toBe(ts2);
		expect(s2.activeMessageId).toBeNull();
		expect(s2.pendingIds.length).toBe(0);
		expect(s2.resolvedIds.length).toBe(1);

		const sigEvt = makeEvent("turn_outcome", {}, s2.messages.m1.resolvedAt!);
		const signals = proj.extractSignals!(s2, sigEvt);
		const resolved = signals.filter((s) => s.type === UserMessageResolutionSignals.resolved.type);
		expect(resolved.length).toBe(1);
		expect((resolved[0].payload as Record<string, unknown>).messageId).toBe("m1");
	});

	it("received → deferred via session.queue_updated", () => {
		const proj = createUserMessageResolutionProjection();
		const initial = getInitial(proj);

		const s1 = proj.reduce(initial, makeEvent("user_message", { messageId: "m2", text: "question" }));
		expect(s1.messages.m2.status).toBe("pending");
		expect(s1.activeMessageId).toBe("m2");

		const ts2 = "2025-01-01T00:00:01.000Z";
		const queueEvt = makeEvent("session.queue_updated", { followUp: 2, steering: 0 }, ts2);
		const s2 = proj.reduce(s1, queueEvt);
		expect(s2.messages.m2.status).toBe("deferred");
		expect(s2.messages.m2.deferredAt).toBe(ts2);
		expect(s2.activeMessageId).toBeNull();
		expect(s2.pendingIds.length).toBe(0);
		expect(s2.deferredIds.length).toBe(1);

		const signals = proj.extractSignals!(s2, queueEvt);
		const deferred = signals.filter((s) => s.type === UserMessageResolutionSignals.deferred.type);
		expect(deferred.length).toBe(1);
		expect((deferred[0].payload as Record<string, unknown>).messageId).toBe("m2");
	});

	it("messageId missing → state unchanged", () => {
		const proj = createUserMessageResolutionProjection();
		const initial = getInitial(proj);

		const s1 = proj.reduce(initial, makeEvent("user_message", { text: "hello" }));
		expect(s1.messages).toEqual({});
		expect(s1.pendingIds.length).toBe(0);
		expect(s1.activeMessageId).toBeNull();

		const signals = proj.extractSignals!(s1, makeEvent("user_message", { text: "hello" }));
		expect(signals.length).toBe(0);
	});
});
