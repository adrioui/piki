import { describe, expect, it } from "vitest";
import type { AtifAlpha22Step, AtifDocument } from "../../../src/core/atif.ts";
import { exportAtifAlpha22 } from "../../../src/core/atif.ts";
import type { SessionEntry, SessionHeader } from "../../../src/core/session-manager.ts";

const mockHeader: SessionHeader = {
	type: "session",
	version: 3,
	id: "sci-wave2-session",
	timestamp: "2026-07-18T10:00:00.000Z",
	cwd: "/home/user/project",
};

function compactionEntry(): SessionEntry {
	return {
		type: "compaction",
		id: "comp-1",
		parentId: "msg-1",
		timestamp: "2026-07-18T10:00:10.000Z",
		summary: "Compacted earlier turns.",
		firstKeptEntryId: "msg-2",
		tokensBefore: 4000,
	};
}

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

function assistantEntry(forkId: string): SessionEntry {
	return {
		type: "message",
		id: "a-1",
		parentId: "u-1",
		timestamp: "2026-07-18T10:00:02.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: "m",
			provider: "p",
			api: "p",
			stopReason: "stop",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		},
		forkId,
	};
}

describe("ATIF shape vs mag oracle (sci-wave2)", () => {
	it("S7: compaction step nests context_management under extra (matches mag alpha22 oracle)", () => {
		const doc = exportAtifAlpha22(mockHeader, [userEntry(), assistantEntry("fork-leader"), compactionEntry()]);
		const sysStep = doc.steps.find(
			(s) => s.source === "system" && (s as { extra?: Record<string, unknown> }).extra?.context_management,
		) as AtifAlpha22Step & { extra?: { context_management?: unknown } };
		expect(sysStep).toBeDefined();
		// mag oracle: step.extra.context_management (no top-level field).
		expect((sysStep as { context_management?: unknown }).context_management).toBeUndefined();
		expect(sysStep.extra?.context_management).toBeDefined();
	});

	it("S8: emits no observer step when there is no observer activity (observer step only on observer_outcome)", () => {
		const doc = exportAtifAlpha22(mockHeader, [userEntry(), assistantEntry("fork-leader")]);
		const observerStep = doc.steps.find(
			(s) => s.source === "system" && (s as { extra?: Record<string, unknown> }).extra?.observer === true,
		);
		// mag parity: observer_outcome → ATIF step only when an observer assessment
		// occurred; with only user/assistant entries no observer step is produced.
		expect(observerStep).toBeUndefined();
	});

	it("S5: subagent trajectory agent.name uses the fork role (mag: agent.name || magnitude-<role>)", () => {
		const forkEntries = new Map<string, SessionEntry[]>([
			["fork-worker-1", [userEntry(), assistantEntry("fork-worker-1")]],
		]);
		const forkMeta = new Map<
			string,
			{
				agentId: string;
				parentForkId: string | null;
				role: string;
				taskId: string | undefined;
				mode: string;
				message: string | undefined;
			}
		>([
			[
				"fork-worker-1",
				{
					agentId: "fork-worker-1",
					parentForkId: null,
					role: "scout",
					taskId: undefined,
					mode: "spawn",
					message: "go",
				},
			],
		]);
		const doc = exportAtifAlpha22(mockHeader, [userEntry(), assistantEntry("fork-leader")], {
			forkEntries,
			forkMeta,
		});
		expect(doc.subagent_trajectories.length).toBe(1);
		const sub = doc.subagent_trajectories[0] as AtifDocument;
		// mag oracle: agent.name === role ("scout").
		expect(sub.agent.name).toBe("scout");
	});

	it("S6: total_steps counts every entry (root + subagent) — MATCH", () => {
		const forkEntries = new Map<string, SessionEntry[]>([
			["fork-worker-1", [userEntry(), assistantEntry("fork-worker-1")]],
		]);
		const doc = exportAtifAlpha22(mockHeader, [userEntry(), assistantEntry("fork-leader")], { forkEntries });
		// root: 2 entries; subagent: 2 entries => 4 total steps.
		expect(doc.final_metrics.total_steps).toBe(4);
	});

	it("S7: failed LLM call yields llm_call_count 0 — MATCH", () => {
		const failed: SessionEntry = {
			type: "message",
			id: "a-fail",
			parentId: "u-1",
			timestamp: "2026-07-18T10:00:03.000Z",
			message: {
				role: "assistant",
				content: [],
				model: "m",
				provider: "p",
				api: "p",
				stopReason: "error",
				errorMessage: "boom",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
			forkId: "fork-leader",
			llmFailed: true,
		};
		const doc = exportAtifAlpha22(mockHeader, [userEntry(), failed]);
		const agentStep = doc.steps.find((s) => s.source === "agent") as { llm_call_count: number };
		expect(agentStep.llm_call_count).toBe(0);
	});
});
