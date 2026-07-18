/**
 * Wave-22 Scientist audit: compaction / continuation / checkpoints / ATIF export.
 *
 * Deterministic (no model, no real provider) verification of piki↔Magnitude
 * alpha22 behavioral parity for the compaction + continuation + ATIF dimensions.
 *
 * Magnitude reference regions (magnitude-alpha22.embedded.js):
 *  - COMPACTION_FALLBACK_KEEP_RATIO = 0.25, KEEP_MESSAGE_RATIO = 0.1 (line 82276)
 *  - computeCompactionSizing() (136849): keepBudget = softCap * KEEP_MESSAGE_RATIO
 *  - CompactionProjection.deriveShouldCompact (115812): shouldCompact when
 *    tag === "idle" && tokenEstimate > limits.softCap
 *  - compactionInjected fallback branch (114393): fallbackBudget =
 *    roleConfig.softCap * COMPACTION_FALLBACK_KEEP_RATIO; tail-keep raw entries
 *  - compactionPreparedToStep (116499): emits context_management with
 *    { type:"compaction", boundary:"replace", compactedMessageCount,
 *      ...isFallback?{isFallback:true} }
 *  - agentCreatedToStep (116449): source:"agent" spawnWorker tool_call +
 *    observation.results[].subagent_trajectory_ref (S6 / ATIF S5-S8)
 */

import { describe, expect, it } from "vitest";
import { COMPACTION_FALLBACK_KEEP_RATIO, KEEP_MESSAGE_RATIO } from "../../../../event-core/src/constants.ts";
import { type AtifAlpha22Step, exportAtifAlpha22 } from "../../../src/core/atif.ts";
import {
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	shouldCompact,
} from "../../../src/core/compaction/compaction.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";

type Entry = SessionEntry;

function msg(id: string, role: "user" | "assistant", over: Partial<Entry> = {}): Entry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message:
			role === "assistant"
				? { role, content: [{ type: "text", text: "x" }], usage: { input: 10, output: 5 } }
				: { role, content: [{ type: "text", text: "x" }] },
		...over,
	} as unknown as Entry;
}

function compaction(id: string, firstKeptEntryId: string, summary: string, over: Partial<Entry> = {}): Entry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 100,
		...over,
	} as unknown as Entry;
}

function systemSteps(steps: AtifAlpha22Step[]): Array<AtifAlpha22Step & { source: "system" }> {
	return steps.filter((s) => (s as { source?: string }).source === "system") as Array<
		AtifAlpha22Step & {
			source: "system";
		}
	>;
}

describe("W22 — compaction trigger threshold parity (mag deriveShouldCompact)", () => {
	it("shouldCompact triggers only above softCap (mirrors mag tokenEstimate > limits.softCap)", () => {
		// softCap for a 200k window = floor(min(0.9*(200000-8192), 200000)) = 172608
		const contextWindow = 200_000;
		const settings = { ...DEFAULT_COMPACTION_SETTINGS };

		const below = shouldCompact(172_000, contextWindow, settings);
		const atCap = shouldCompact(172_608, contextWindow, settings);
		const above = shouldCompact(173_000, contextWindow, settings);

		expect(below).toBe(false);
		expect(atCap).toBe(false);
		expect(above).toBe(true);
	});

	it("KEEP_MESSAGE_RATIO matches mag (0.1)", () => {
		expect(KEEP_MESSAGE_RATIO).toBe(0.1);
	});
});

describe("W22 — fallback budget ratio parity (mag COMPACTION_FALLBACK_KEEP_RATIO=0.25)", () => {
	it("fallback keep ratio constant equals mag's 0.25", () => {
		expect(COMPACTION_FALLBACK_KEEP_RATIO).toBe(0.25);
	});
});

describe("W22 — continuation checkpoints (iterative compaction)", () => {
	it("prepareCompaction feeds the prior compaction summary as previousSummary (continuation)", () => {
		const entries: Entry[] = [
			msg("u1", "user"),
			msg("a1", "assistant"),
			compaction("c1", "a1", "prior summary text"),
			msg("u2", "user"),
			msg("a2", "assistant"),
		];
		// Force a real cut by bounding the recent-keep budget so the prefix is
		// summarized (mirrors a live session that has grown past the keep window).
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 5 };
		const prep = prepareCompaction(entries, settings);
		expect(prep).toBeDefined();
		// Continuation: the second compaction must carry the prior summary so the
		// LLM merges rather than restarts (mag keeps the live window from
		// firstKeptEntryId and re-summarizes only the new prefix).
		expect(prep!.previousSummary).toBe("prior summary text");
		// boundaryStart advances past the prior compaction so we don't re-summarize
		// discarded history.
		expect(entries.findIndex((e) => e.id === prep!.firstKeptEntryId)).toBeGreaterThan(
			entries.findIndex((e) => e.id === "c1"),
		);
	});

	it("prepareCompaction returns undefined when the latest entry is already a compaction (no double-compact)", () => {
		const entries: Entry[] = [msg("u1", "user"), msg("a1", "assistant"), compaction("c1", "a1", "s")];
		const prep = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS, 200_000);
		expect(prep).toBeUndefined();
	});
});

describe("W22 — ATIF export: fallback + fork-entries coexist (G7 + S6)", () => {
	it("fallback compaction still emits spawnWorker subagent_trajectory_ref steps for forks", () => {
		const leader: Entry[] = [
			msg("u1", "user"),
			msg("a1", "assistant"),
			compaction("c1", "a1", "compressed", { details: { fallback: true } } as Partial<Entry>),
		];
		const forkEntries = new Map<string, Entry[]>([["f1", [msg("wu1", "user"), msg("wa1", "assistant")]]]);
		const doc = exportAtifAlpha22(null, leader, { forkEntries });

		const sys = systemSteps(doc.steps);
		const comp = sys.find(
			(s) => (s as { extra?: { context_management?: unknown } }).extra?.context_management,
		) as unknown as {
			extra: { context_management: { isFallback?: boolean } };
		};
		expect(comp).toBeDefined();
		expect(comp.extra.context_management.isFallback).toBe(true);

		const agents = doc.steps.filter((s) => (s as { source?: string }).source === "agent") as Array<{
			source: "agent";
			tool_calls?: Array<{ function_name: string }>;
		}>;
		const spawn = agents.find((s) => s.tool_calls?.some((t) => t.function_name === "spawnWorker"));
		expect(spawn).toBeDefined();
		expect(doc.subagent_trajectories).toHaveLength(1);
	});

	it("ATIF compactedMessageCount is window-bounded across nested compactions (continuation)", () => {
		// Layout mirrors the mag live-window model: c1 keeps from a2 (removes
		// u1,a1,u2 = 3); c2 keeps from a4 (removes a2,u3,a3,u4 = 4) within the
		// post-c1 live window. This must NOT sum to 7.
		const entries: Entry[] = [
			msg("u1", "user"),
			msg("a1", "assistant"),
			msg("u2", "user"),
			msg("a2", "assistant"),
			compaction("c1", "a2", "s1"),
			msg("u3", "user"),
			msg("a3", "assistant"),
			msg("u4", "user"),
			msg("a4", "assistant"),
			compaction("c2", "a4", "s2"),
		];
		const doc = exportAtifAlpha22(null, entries);
		const cms = systemSteps(doc.steps).map(
			(s) =>
				(s as unknown as { extra: { context_management: { compactedMessageCount: number } } }).extra
					.context_management.compactedMessageCount,
		);
		expect(cms[0]).toBe(3);
		expect(cms[1]).toBe(4);
		// Continuation invariant: second compaction count is bounded by its own
		// live window, not the cumulative pre-c1 history.
		expect(cms[1]).toBeLessThan(cms[0] + cms[1]);
	});
});

describe("W22 — checkpoints/continuation tool parity (mag checkpoint_changes/rollback)", () => {
	it("piki exposes the exact mag checkpoint tool names", async () => {
		const { createCheckpointChangesToolDefinition } = await import("../../../src/core/tools/checkpoint-changes.ts");
		const { createCheckpointRollbackToolDefinition } = await import("../../../src/core/tools/checkpoint-rollback.ts");
		expect(createCheckpointChangesToolDefinition(".", "session-1").name).toBe("checkpoint_changes");
		expect(createCheckpointRollbackToolDefinition(".", "session-1").name).toBe("checkpoint_rollback");
	});
});
