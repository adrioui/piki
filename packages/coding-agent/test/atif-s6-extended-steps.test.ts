/**
 * S6 — ATIF extended step types (piki vs mag alpha22 parity).
 *
 * Verifies `entriesToAlpha22Steps` / `exportAtifAlpha22` emit alpha22-compatible
 * `source:"system"` steps for non-message event entries (compaction,
 * branch_summary), in addition to the message-derived user/agent steps.
 *
 * NOTE: piki captures worker forks as `message` entries carrying a `forkId`
 * (handled by S5/S8), so there is no separate `agent_created` entry type to
 * map to a `spawnWorker` tool_call. The fork/worker trajectory parity itself is
 * covered by `atif-s5s8-fork-entries.test.ts`; this file covers the
 * leader-side event-step vocabulary gaps that the audit flagged as missing.
 */

import { describe, expect, it } from "vitest";
import { exportAtifAlpha22 } from "../src/core/atif.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

function msg(role: "user" | "assistant", content: string, forkId: string | null = null): SessionEntry {
	const base = {
		role,
		content: [{ type: "text", text: content }],
		timestamp: Date.now(),
	};
	const message =
		role === "assistant"
			? {
					...base,
					api: "openai-completions",
					provider: "faux",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
				}
			: base;
	return {
		type: "message",
		id: `m-${Math.random()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: message as never,
		forkId,
	};
}

describe("S6 — ATIF extended step types", () => {
	it("emits a source:system context_management step for a compaction entry", () => {
		const entries: SessionEntry[] = [
			msg("user", "Task"),
			msg("assistant", "Working"),
			{
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "Context compressed",
				firstKeptEntryId: "x",
				tokensBefore: 1000,
				fromHook: false,
			},
			msg("user", "Continue"),
		];
		const doc = exportAtifAlpha22(null, entries);
		const systemSteps = doc.steps.filter((s) => (s as { source: string }).source === "system");
		expect(systemSteps.length).toBe(1);
		const compactionStep = systemSteps[0] as {
			source: string;
			extra: { context_management?: { type: string; boundary: string; compactedMessageCount?: number } };
			message: string;
		};
		// S6: compaction step carries a mag-shaped object, not a boolean.
		// alpha22 nests `context_management` under `extra` (compactionPreparedToStep),
		// which is what piki emits.
		expect(compactionStep.extra.context_management).toBeDefined();
		expect(compactionStep.extra.context_management?.type).toBe("compaction");
		expect(compactionStep.extra.context_management?.boundary).toBe("replace");
		// Both message entries before the compaction were replaced.
		expect(compactionStep.extra.context_management?.compactedMessageCount).toBe(2);
		expect(compactionStep.message).toContain("Context compressed");
		// GAP-6: compaction step carries an `observation.results` entry with the
		// summary (mirrors mag `compactionPreparedToStep`).
		expect(
			(compactionStep as { observation?: { results: Array<{ content: string }> } }).observation?.results[0]?.content,
		).toBe("Context compressed");
		// S5: total_steps counts ALL steps (user, assistant, AND the compaction
		// system step), matching alpha22 fork.steps.length. user + assistant +
		// compaction + user = 4.
		expect(doc.final_metrics.total_steps).toBe(4);
	});

	it("emits a source:system step for a branch_summary entry", () => {
		const entries: SessionEntry[] = [
			msg("user", "Task"),
			{
				type: "branch_summary",
				id: "b1",
				parentId: null,
				timestamp: new Date().toISOString(),
				fromId: "root",
				summary: "Branch summary text",
				fromHook: false,
			},
		];
		const doc = exportAtifAlpha22(null, entries);
		const systemSteps = doc.steps.filter((s) => (s as { source: string }).source === "system");
		expect(systemSteps.length).toBe(1);
		expect((systemSteps[0] as { message: string }).message).toContain("Branch summary text");
	});

	it("emits a source:system step for model_change and custom entries", () => {
		const entries: SessionEntry[] = [
			msg("user", "Task"),
			{
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				provider: "openai",
				modelId: "gpt-5",
			},
			{
				type: "custom",
				id: "cu1",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "note",
				data: { a: 1 },
			},
		];
		const doc = exportAtifAlpha22(null, entries);
		const systemSteps = doc.steps.filter((s) => (s as { source: string }).source === "system");
		expect(systemSteps.length).toBe(2);
		const messageTexts = systemSteps.map((s) => (s as { message: string }).message);
		expect(messageTexts.some((t) => t.includes("gpt-5"))).toBe(true);
	});
});

describe("S6 — spawnWorker / subagent_trajectory_ref (agent_created)", () => {
	it("emits a spawnWorker agent step linking the fork via subagent_trajectory_ref", () => {
		const leaderEntries: SessionEntry[] = [msg("user", "Task"), msg("assistant", "Delegating to a worker.")];
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "fu1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Investigate", timestamp: Date.now() },
				forkId: "fork-1",
			},
			{
				type: "message",
				id: "fa1",
				parentId: "fu1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
					api: "openai-completions",
					provider: "faux",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				forkId: "fork-1",
			},
		];

		const doc = exportAtifAlpha22(null, leaderEntries, {
			forkEntries: new Map([["fork-1", forkEntries]]),
		});

		const spawnStep = doc.steps.find(
			(s) =>
				(s as { source: string }).source === "agent" &&
				(s as { tool_calls?: Array<{ function_name: string }> }).tool_calls?.some(
					(tc) => tc.function_name === "spawnWorker",
				),
		) as
			| {
					source: string;
					tool_calls: Array<{ function_name: string; arguments: unknown }>;
					observation?: { results: Array<{ subagent_trajectory_ref?: Array<{ trajectory_id: string }> }> };
					extra: { agentId: string; forkId: string; parentForkId: string | null; taskId: string };
					llm_call_count: number;
			  }
			| undefined;

		expect(spawnStep).toBeDefined();
		if (!spawnStep) return;
		expect(spawnStep.tool_calls[0]!.function_name).toBe("spawnWorker");
		expect((spawnStep.tool_calls[0]!.arguments as { taskId: string }).taskId).toBe("fork-1");
		expect(spawnStep.observation?.results[0]?.subagent_trajectory_ref).toEqual([{ trajectory_id: "fork-1" }]);
		expect(spawnStep.extra.agentId).toBe("fork-1");
		expect(spawnStep.extra.forkId).toBe("fork-1");
		expect(spawnStep.extra.parentForkId).toBeNull();
		expect(spawnStep.llm_call_count).toBe(0);

		// step_ids remain monotonic across the merged root steps.
		expect(doc.steps.map((s) => s.step_id)).toEqual(doc.steps.map((_, i) => i + 1));
	});

	it("S5: total_steps counts non-message entries and fork steps combined", () => {
		// leader: user + assistant + compaction (system) = 3 steps
		const leaderEntries: SessionEntry[] = [
			msg("user", "Task"),
			msg("assistant", "Working."),
			{
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "Compressed",
				firstKeptEntryId: "x",
				tokensBefore: 500,
				fromHook: false,
			},
		];
		// fork: user + assistant = 2 steps
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "fu1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "go", timestamp: Date.now() },
				forkId: "fork-2",
			},
			{
				type: "message",
				id: "fa1",
				parentId: "fu1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-completions",
					provider: "faux",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				forkId: "fork-2",
			},
		];

		const doc = exportAtifAlpha22(null, leaderEntries, {
			forkEntries: new Map([["fork-2", forkEntries]]),
		});
		// leader 3 + fork 2 = 5 (the synthetic spawnWorker step is NOT a message
		// entry and is not counted by computeAtifFinalMetrics, matching alpha22
		// which counts fork.steps.length from captured entries, not synthesized
		// agent_created steps).
		expect(doc.final_metrics.total_steps).toBe(5);
	});

	it("emits no spawnWorker step when there are no fork entries (backward compat)", () => {
		const doc = exportAtifAlpha22(null, [msg("user", "Task"), msg("assistant", "Ok")]);
		const hasSpawn = doc.steps.some((s) =>
			(s as { tool_calls?: Array<{ function_name: string }> }).tool_calls?.some(
				(tc) => tc.function_name === "spawnWorker",
			),
		);
		expect(hasSpawn).toBe(false);
	});
});
