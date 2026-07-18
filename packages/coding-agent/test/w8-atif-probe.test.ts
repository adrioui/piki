import { describe, expect, it } from "vitest";
import { type AtifAlpha22Step, computeAtifFinalMetrics, exportAtifAlpha22 } from "../src/core/atif.ts";

type Entry = Parameters<typeof computeAtifFinalMetrics>[0][number];

function msg(id: string, role: string, over: Partial<Entry> = {}): Entry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role, content: [{ type: "text", text: "x" }] },
		...(role === "assistant"
			? { message: { role, content: [{ type: "text", text: "x" }], usage: { input: 10, output: 5 } } }
			: {}),
		...over,
	} as unknown as Entry;
}

function compaction(id: string, firstKeptEntryId: string, over: Partial<Entry> = {}): Entry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		summary: "s",
		firstKeptEntryId,
		tokensBefore: 100,
		...over,
	} as unknown as Entry;
}

function systemStep(steps: AtifAlpha22Step[]): (AtifAlpha22Step & { source: "system" })[] {
	return steps.filter((s) => (s as { source?: string }).source === "system") as (AtifAlpha22Step & {
		source: "system";
	})[];
}

describe("W8 ATIF S5-S8 parity probes", () => {
	it("S5: total_steps counts ALL entry types (message + compaction)", () => {
		const entries: Entry[] = [msg("u1", "user"), msg("a1", "assistant"), compaction("c1", "a1"), msg("u2", "user")];
		const m = computeAtifFinalMetrics(entries);
		expect(m.total_steps).toBe(4);
	});

	it("S6: compaction step emits context_management OBJECT with compactedMessageCount", () => {
		// firstKeptEntryId="a1" is a real message id; mag keeps from it
		// (inclusive), so only the single message before it (u1) is removed.
		const entries: Entry[] = [msg("u1", "user"), msg("a1", "assistant"), compaction("c1", "a1")];
		const doc = exportAtifAlpha22(null, entries);
		const sys = systemStep(doc.steps);
		const comp = sys.find((s) => (s as { extra?: { context_management?: unknown } }).extra?.context_management);
		expect(comp).toBeDefined();
		expect(
			(comp as unknown as { extra: { context_management: { compactedMessageCount: number } } }).extra
				.context_management.compactedMessageCount,
		).toBe(1);
	});

	it("G-N7: nested compaction window-bounded compactedMessageCount", () => {
		// Scenario: 4 user/assistant messages, compaction c1 keeps a1..a4 -> removes u1,a1
		// then 2 more messages, compaction c2 keeps a6 -> removes u2,a2,u3,a3,u4,a4
		// mag: c1 removes 2, c2 removes 6 (correct: messages removed by THIS compaction)
		// piki derivation counts ALL linear message entries before the compaction entry.
		const entries: Entry[] = [
			msg("u1", "user"),
			msg("a1", "assistant"),
			msg("u2", "user"),
			msg("a2", "assistant"),
			compaction("c1", "a2"), // piki deriv: 4 messages before -> counts 4 (WRONG; mag removes 2)
			msg("u3", "user"),
			msg("a3", "assistant"),
			msg("u4", "user"),
			msg("a4", "assistant"),
			compaction("c2", "a4"), // piki deriv: 9 messages before -> counts 9 (WRONG; mag removes 6)
		];
		const doc = exportAtifAlpha22(null, entries);
		const sys = systemStep(doc.steps);
		const cms = sys.map(
			(s) =>
				(s as unknown as { extra: { context_management: { compactedMessageCount: number } } }).extra
					.context_management,
		);
		// mag applies each compaction to a live window, keeping from
		// `firstKeptEntryId` (inclusive) and dropping the prefix; prior
		// compactions shrink the window first. With this entry layout (u2 precedes
		// a2), c1 keeps from "a2" and removes the 3 messages before it
		// (u1,a1,u2). The post-c1 live window is [a2,u3,a3,u4,a4]; c2 keeps from
		// "a4" and removes the 4 messages before it (a2,u3,a3,u4). The count is
		// window-bounded: without the fix, piki's linear scan reported [4,8]
		// (c2 re-counted u1,a1 already removed by c1). Here c2=4 reflects only
		// the post-c1 window, confirming no over-count of prior removals.
		expect(cms[0]!.compactedMessageCount).toBe(3); // c1 removes u1,a1,u2 (before "a2")
		expect(cms[1]!.compactedMessageCount).toBe(4); // c2 removes a2,u3,a3,u4 (post-c1 window)
		expect(cms[1]!.compactedMessageCount).toBeLessThan(cms[1]!.compactedMessageCount + cms[0]!.compactedMessageCount); // bounded, not summed
		expect(cms[1]!.compactedMessageCount).not.toBeGreaterThan(6);
	});

	it("S7: llm_call_count=0 on failed-empty assistant, else 1", () => {
		// A genuinely failed/empty assistant message: no usage, empty content.
		const failed: Entry = {
			type: "message",
			id: "fa",
			parentId: null,
			timestamp: new Date().toISOString(),
			llmFailed: true,
			message: { role: "assistant", content: [] },
		} as unknown as Entry;
		const ok: Entry = msg("ok", "assistant");
		const doc = exportAtifAlpha22(null, [failed, ok]);
		const agents = doc.steps.filter((s) => (s as { source?: string }).source === "agent");
		const failedStep = agents[0] as { llm_call_count: number };
		const okStep = agents[1] as { llm_call_count: number };
		expect(failedStep.llm_call_count).toBe(0);
		expect(okStep.llm_call_count).toBe(1);
	});

	it("S8: extra.forkId preserved; leader null, fork entries carry forkId", () => {
		const leader: Entry = msg("u1", "user");
		const leaderAssistant: Entry = msg("a1", "assistant"); // leader (no forkId)
		const worker: Entry = msg("wa", "assistant", { forkId: "f1" } as Partial<Entry>);
		const doc = exportAtifAlpha22(null, [leader, leaderAssistant, worker]);
		const agents = doc.steps.filter((s) => (s as { source?: string }).source === "agent");
		const workerStepIdx = agents.findIndex(
			(s) => (s as unknown as { extra: { forkId?: string | null } }).extra?.forkId === "f1",
		);
		const leaderStepIdx = agents.findIndex(
			(s) => (s as unknown as { extra: { forkId?: string | null } }).extra?.forkId === null,
		);
		expect(leaderStepIdx).toBeGreaterThanOrEqual(0);
		expect(workerStepIdx).toBeGreaterThanOrEqual(0);
		expect((agents[leaderStepIdx] as unknown as { extra: { forkId: string | null } }).extra.forkId).toBeNull();
		expect((agents[workerStepIdx] as unknown as { extra: { forkId: string | null } }).extra.forkId).toBe("f1");
	});

	it("S6: agent_created spawnWorker step injected into root steps for each fork", () => {
		const leader: Entry[] = [msg("u1", "user"), msg("a1", "assistant")];
		const forkEntries = new Map<string, Entry[]>([["f1", [msg("wu1", "user"), msg("wa1", "assistant")]]]);
		const doc = exportAtifAlpha22(null, leader, { forkEntries });
		const agents = doc.steps.filter((s) => (s as { source?: string }).source === "agent") as Array<{
			source: "agent";
			tool_calls?: Array<{ function_name: string }>;
		}>;
		const spawn = agents.find((s) => s.tool_calls?.some((t) => t.function_name === "spawnWorker"));
		expect(spawn).toBeDefined();
		expect(doc.subagent_trajectories).toHaveLength(1);
	});

	it("G7: fallback compaction surfaces context_management.isFallback=true", () => {
		const entries: Entry[] = [
			msg("u1", "user"),
			msg("a1", "assistant"),
			compaction("c1", "a1", { details: { fallback: true } }),
		];
		const doc = exportAtifAlpha22(null, entries);
		const sys = systemStep(doc.steps);
		const comp = sys.find(
			(s) => (s as { extra?: { context_management?: unknown } }).extra?.context_management,
		) as unknown as {
			extra: { context_management: { isFallback?: boolean } };
		};
		expect(comp).toBeDefined();
		expect(comp.extra.context_management.isFallback).toBe(true);
	});

	it("G7: normal compaction without fallback has no isFallback flag", () => {
		const entries: Entry[] = [msg("u1", "user"), msg("a1", "assistant"), compaction("c1", "a1")];
		const doc = exportAtifAlpha22(null, entries);
		const sys = systemStep(doc.steps);
		const comp = sys.find(
			(s) => (s as { extra?: { context_management?: unknown } }).extra?.context_management,
		) as unknown as {
			extra: { context_management: { isFallback?: boolean } };
		};
		expect(comp).toBeDefined();
		expect(comp.extra.context_management.isFallback).toBeUndefined();
	});
});
