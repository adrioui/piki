import { describe, expect, it } from "vitest";
import type { AtifAlpha22Step, AtifDocument } from "../../../src/core/atif.ts";
import { exportAtifAlpha22 } from "../../../src/core/atif.ts";
import type { ObserverEntry, SessionEntry, SessionHeader } from "../../../src/core/session-manager.ts";

const mockHeader: SessionHeader = {
	type: "session",
	version: 3,
	id: "w19-observer-session",
	timestamp: "2026-07-18T10:00:00.000Z",
	cwd: "/home/user/project",
};

function userEntry(): SessionEntry {
	return {
		type: "message",
		id: "u-1",
		parentId: null,
		timestamp: "2026-07-18T10:00:01.000Z",
		message: { role: "user", content: "hello", timestamp: Date.now() },
		forkId: "fork-leader",
	};
}

function observerEntry(escalate: boolean, justification: string | undefined, message: string): ObserverEntry {
	return {
		type: "observer",
		id: escalate ? "obs-esc" : "obs-pass",
		parentId: "u-1",
		timestamp: "2026-07-18T10:00:02.000Z",
		escalate,
		justification,
		message,
	};
}

describe("ATIF S8 observer step serialization (w19 GAP-2)", () => {
	it("emits a system step for an escalating observer assessment with extra.observer/escalate/justification", () => {
		const doc: AtifDocument = exportAtifAlpha22(mockHeader, [
			userEntry(),
			observerEntry(true, "loop detected", "<escalation_required>\nloop detected\n</escalation_required>"),
		]);

		const obsStep = doc.steps.find(
			(s) => s.source === "system" && (s.extra as Record<string, unknown>).observer === true,
		) as (AtifAlpha22Step & { extra: Record<string, unknown> }) | undefined;
		expect(obsStep).toBeDefined();
		expect(obsStep!.extra.observer).toBe(true);
		expect(obsStep!.extra.escalate).toBe(true);
		expect(obsStep!.extra.justification).toBe("loop detected");
		expect(typeof obsStep!.message).toBe("string");
	});

	it("emits a system step for a non-escalating observer assessment (extra.escalate === false)", () => {
		const doc: AtifDocument = exportAtifAlpha22(mockHeader, [userEntry(), observerEntry(false, undefined, "pass")]);

		const obsStep = doc.steps.find(
			(s) => s.source === "system" && (s.extra as Record<string, unknown>).observer === true,
		) as (AtifAlpha22Step & { extra: Record<string, unknown> }) | undefined;
		expect(obsStep).toBeDefined();
		expect(obsStep!.extra.observer).toBe(true);
		expect(obsStep!.extra.escalate).toBe(false);
		expect(obsStep!.extra.justification).toBeUndefined();
		expect(obsStep!.message).toBe("Observer assessment: pass");
	});

	it("counts the observer step toward total_steps (mag parity: observer outcomes are steps)", () => {
		const doc: AtifDocument = exportAtifAlpha22(mockHeader, [
			userEntry(),
			observerEntry(true, "loop detected", "<escalation_required>\nloop detected\n</escalation_required>"),
		]);
		expect(doc.steps.length).toBe(2);
	});
});
