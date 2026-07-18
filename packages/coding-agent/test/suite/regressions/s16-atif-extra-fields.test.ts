import type { AssistantMessage } from "@piki/ai";
import { describe, expect, it } from "vitest";
import { exportAtifAlpha22 } from "../../../src/core/atif.ts";
import type { SessionEntry, SessionHeader } from "../../../src/core/session-manager.ts";

const mockHeader: SessionHeader = {
	type: "session",
	version: 3,
	id: "s16-test-session",
	timestamp: "2026-07-04T10:00:00.000Z",
	cwd: "/home/user/project",
};

function assistantEntry(stopReason: "stop" | "toolUse", responseId?: string): SessionEntry {
	return {
		type: "message",
		id: stopReason === "stop" ? "msg-stop" : "msg-tooluse",
		parentId: null,
		forkId: "fork-1",
		timestamp: "2026-07-04T10:00:05.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "response text" }],
			model: "deepseek-v4-pro",
			provider: "commandcode",
			...(responseId !== undefined ? { responseId } : {}),
			stopReason,
			api: "commandcode",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		},
	};
}

function findAgentStep(entries: SessionEntry[]) {
	const doc = exportAtifAlpha22(mockHeader, entries);
	const agentSteps = doc.steps.filter((s) => s.source === "agent");
	expect(agentSteps).toHaveLength(1);
	return agentSteps[0] as { extra: Record<string, unknown> };
}

describe("ATIF alpha22 agent-step extra.outcome / extra.responseId (S16)", () => {
	it("emits extra.outcome from stopReason and extra.responseId from responseId", () => {
		const step = findAgentStep([assistantEntry("stop", "resp_abc")]);
		// extra.outcome is normalized to mag's alpha22 outcome tag vocabulary
		// (mapFinishReasonToOutcome): a normal stop maps to "Completed".
		expect(step.extra.outcome).toBe("Completed");
		expect(step.extra.responseId).toBe("resp_abc");
		expect(step.extra.turnId).toBe("msg-stop");
		expect(step.extra.forkId).toBe("fork-1");
		expect(step.extra.providerId).toBe("commandcode");
		expect(step.extra.modelId).toBe("deepseek-v4-pro");
	});

	it("emits extra.outcome from a non-stop stopReason and omits responseId when absent", () => {
		const step = findAgentStep([assistantEntry("toolUse")]);
		// toolUse also normalizes to "Completed" (mag's outcome tag, not the raw stopReason).
		expect(step.extra.outcome).toBe("Completed");
		expect(step.extra.responseId).toBeUndefined();
	});

	it("omits extra.outcome and extra.responseId when the message has no stopReason", () => {
		// Every real AssistantMessage carries stopReason, but the export must be
		// absent-safe if those fields are ever missing. Exercise the path with a
		// structurally minimal assistant message lacking the optional fields.
		const minimal = {
			role: "assistant",
			content: [{ type: "text", text: "response text" }],
			model: "deepseek-v4-pro",
			provider: "commandcode",
			api: "commandcode",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as unknown as AssistantMessage;
		const entry: SessionEntry = {
			type: "message",
			id: "msg-min",
			parentId: null,
			forkId: "fork-1",
			timestamp: "2026-07-04T10:00:05.000Z",
			message: minimal,
		};
		const step = findAgentStep([entry]);
		expect(step.extra.outcome).toBeUndefined();
		expect(step.extra.responseId).toBeUndefined();
	});
});
