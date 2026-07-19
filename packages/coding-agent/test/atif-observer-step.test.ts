import { describe, expect, it } from "vitest";
import { exportAtifAlpha22 } from "../src/core/atif.ts";
import type { SessionEntry, SessionHeader } from "../src/core/session-manager.ts";

// Mirrors mag alpha22 `observerOutcomeToStep` (magnitude-alpha22.embedded.js:116546):
//   { source: "system", message, reasoning_content: event.reasoning,
//     extra: { observer: true, observedTurnId, observerTurnId, escalate,
//              justification, chainId }, llm_call_count: 0 }
const mockHeader: SessionHeader = {
	type: "session",
	version: 3,
	id: "obs-session-001",
	timestamp: "2026-07-19T10:00:00.000Z",
	cwd: "/home/user/project",
};

const escalateObserverEntry = (
	overrides: Partial<{
		reasoningContent: string | undefined;
		observedTurnId: string | undefined;
		observerTurnId: string | undefined;
		chainId: string | undefined;
	}>,
): SessionEntry => ({
	type: "observer",
	id: "o1",
	parentId: "u1",
	timestamp: "2026-07-19T10:00:05.000Z",
	escalate: true,
	justification: "difficulty",
	message: `<escalation_required>
difficulty
</escalation_required>`,
	observedTurnId: overrides.observedTurnId ?? "turn-001",
	observerTurnId: overrides.observerTurnId ?? "observer-001",
	chainId: overrides.chainId ?? "obs-session-001",
	reasoningContent: overrides.reasoningContent,
});

const baseEntries: SessionEntry[] = [
	{
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: "2026-07-19T10:00:01.000Z",
		message: { role: "user", content: "Help me", timestamp: Date.now() },
	},
];

describe("exportAtifAlpha22 observer step (S8 observerOutcomeToStep parity)", () => {
	it("emits a source:system observer step carrying the S8 identity fields and reasoning_content", () => {
		const doc = exportAtifAlpha22(mockHeader, [
			...baseEntries,
			escalateObserverEntry({ reasoningContent: "I should escalate because the user is stuck." }),
		]);

		const step = doc.steps.find((s) => (s as { extra?: { observer?: unknown } }).extra?.observer === true);
		expect(step).toBeDefined();
		expect(step!.source).toBe("system");
		expect(step!.message).toBe(
			`<escalation_required>
difficulty
</escalation_required>`,
		);
		expect((step as { reasoning_content?: string }).reasoning_content).toBe(
			"I should escalate because the user is stuck.",
		);
		expect((step as { llm_call_count: number }).llm_call_count).toBe(0);
		expect((step as { extra: Record<string, unknown> }).extra).toEqual({
			entryType: "observer",
			observer: true,
			escalate: true,
			justification: "difficulty",
			observedTurnId: "turn-001",
			observerTurnId: "observer-001",
			chainId: "obs-session-001",
		});
	});

	it("omits top-level reasoning_content when the observer entry has no reasoning trace (heuristic-only path)", () => {
		const doc = exportAtifAlpha22(mockHeader, [
			...baseEntries,
			escalateObserverEntry({ reasoningContent: undefined }),
		]);
		const step = doc.steps.find((s) => (s as { extra?: { observer?: unknown } }).extra?.observer === true);
		expect(step).toBeDefined();
		expect((step as { reasoning_content?: string }).reasoning_content).toBeUndefined();
		// Identity fields are still present.
		expect((step as { extra: { observedTurnId?: string } }).extra.observedTurnId).toBe("turn-001");
		expect((step as { extra: { observerTurnId?: string } }).extra.observerTurnId).toBe("observer-001");
		expect((step as { extra: { chainId?: string } }).extra.chainId).toBe("obs-session-001");
	});

	it("does not emit reasoning_content when the trace is only whitespace", () => {
		const doc = exportAtifAlpha22(mockHeader, [
			...baseEntries,
			escalateObserverEntry({ reasoningContent: "   \n\t  " }),
		]);
		const step = doc.steps.find((s) => (s as { extra?: { observer?: unknown } }).extra?.observer === true);
		expect(step).toBeDefined();
		expect((step as { reasoning_content?: string }).reasoning_content).toBeUndefined();
	});

	it("uses 'Observer assessment: pass' message and no extra.justification on a pass entry with no ids", () => {
		const passNoId: SessionEntry[] = [
			...baseEntries,
			{
				type: "observer",
				id: "o2",
				parentId: "u1",
				timestamp: "2026-07-19T10:00:05.000Z",
				escalate: false,
				justification: undefined,
				message: "Observer assessment: pass",
			},
		];
		const doc = exportAtifAlpha22(mockHeader, passNoId);
		const step = doc.steps.find((s) => (s as { extra?: { observer?: unknown } }).extra?.observer === true);
		expect(step).toBeDefined();
		expect(step!.message).toBe("Observer assessment: pass");
		expect((step as { extra: { escalate?: boolean } }).extra.escalate).toBe(false);
		expect((step as { extra: { justification?: unknown } }).extra).not.toHaveProperty("justification");
		expect((step as { extra: { observedTurnId?: unknown } }).extra).not.toHaveProperty("observedTurnId");
		expect((step as { reasoning_content?: string }).reasoning_content).toBeUndefined();
	});

	it("counts the observer step in total_steps (every entry is one step)", () => {
		const doc = exportAtifAlpha22(mockHeader, [
			...baseEntries,
			escalateObserverEntry({ reasoningContent: "reasoning" }),
		]);
		// 1 user message + 1 observer entry = 2 steps total.
		expect(doc.final_metrics.total_steps).toBe(2);
	});
});
