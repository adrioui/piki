import type { AgentMessage } from "@piki/agent-core";
import { describe, expect, test } from "vitest";
import {
	BRANCH_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_PREFIX,
	convertToLlm,
	formatTurnBoundary,
	injectTurnBoundarySeparators,
} from "../src/core/messages.ts";
import { isBoundaryTimestamp } from "../src/core/snapshot.ts";

const user = (timestamp: number, text = "hello"): AgentMessage => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});

const assistant = (timestamp: number): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	api: "openai",
	provider: "openai",
	model: "gpt",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp,
});

const toolResult = (timestamp: number, toolCallId = "c1"): AgentMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "bash",
	content: [{ type: "text", text: "ran" }],
	isError: false,
	timestamp,
});

describe("formatTurnBoundary", () => {
	test("formats local HH:MM:SS with zero padding", () => {
		// 2024-01-02 03:04:05 local
		const d = new Date(2024, 0, 2, 3, 4, 5, 0);
		expect(formatTurnBoundary(d.getTime())).toBe("--- 03:04:05 ---");
	});

	test("matches the boundary timestamp parser", () => {
		const sep = formatTurnBoundary(Date.now());
		// The parser accepts the bare HH:MM:SS the user passes to `since`,
		// which is the inner portion of the separator.
		const inner = sep.replace(/^--- /, "").replace(/ ---$/, "");
		expect(isBoundaryTimestamp(inner)).toBe(true);
	});

	test("conforms to the HH:MM:SS separator shape", () => {
		expect(/^--- \d{1,2}:\d{2}:\d{2} ---$/.test(formatTurnBoundary(Date.now()))).toBe(true);
	});
});

describe("injectTurnBoundarySeparators", () => {
	test("inserts a separator before a user message", () => {
		const ts = 1_700_000_000_000;
		const out = injectTurnBoundarySeparators(convertToLlm([user(ts)]));
		expect(out).toHaveLength(2);
		expect(out[0].role).toBe("user");
		expect((out[0].content as { text: string }[])[0].text).toBe(formatTurnBoundary(ts));
		expect(out[1].role).toBe("user");
	});

	test("gives each of two user messages its own separator with correct timestamps", () => {
		const t1 = 1_700_000_000_000;
		const t2 = 1_700_000_100_000;
		const out = injectTurnBoundarySeparators(convertToLlm([user(t1, "a"), user(t2, "b")]));
		expect(out).toHaveLength(4);
		expect((out[0].content as { text: string }[])[0].text).toBe(formatTurnBoundary(t1));
		expect((out[2].content as { text: string }[])[0].text).toBe(formatTurnBoundary(t2));
	});

	test("does not add separators around assistant/toolResult messages", () => {
		const ts = 1_700_000_000_000;
		const out = injectTurnBoundarySeparators(convertToLlm([user(ts), assistant(ts + 1), toolResult(ts + 2)]));
		// one separator + 3 messages
		expect(out).toHaveLength(4);
		expect((out[0].content as { text: string }[])[0].text).toBe(formatTurnBoundary(ts));
		expect(out[1].role).toBe("user");
		expect(out[2].role).toBe("assistant");
		expect(out[3].role).toBe("toolResult");
	});

	test("does not inject a separator before a compaction summary", () => {
		const summary: AgentMessage = {
			role: "compactionSummary",
			summary: "prior context",
			tokensBefore: 10,
			timestamp: 1_700_000_000_000,
		};
		const ts = 1_700_000_100_000;
		const out = injectTurnBoundarySeparators(convertToLlm([summary, user(ts)]));
		// separator only before the real user message, not the summary
		expect(out).toHaveLength(3);
		expect((out[0].content as { text: string }[])[0].text.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
		expect((out[1].content as { text: string }[])[0].text).toBe(formatTurnBoundary(ts));
		expect(out[2].role).toBe("user");
	});

	test("does not inject a separator before a branch summary", () => {
		const summary: AgentMessage = {
			role: "branchSummary",
			summary: "branch context",
			fromId: "x",
			timestamp: 1_700_000_000_000,
		};
		const ts = 1_700_000_100_000;
		const out = injectTurnBoundarySeparators(convertToLlm([summary, user(ts)]));
		expect(out).toHaveLength(3);
		expect((out[0].content as { text: string }[])[0].text.startsWith(BRANCH_SUMMARY_PREFIX)).toBe(true);
		expect((out[1].content as { text: string }[])[0].text).toBe(formatTurnBoundary(ts));
	});

	test("is idempotent across repeated injection", () => {
		const ts = 1_700_000_000_000;
		const once = injectTurnBoundarySeparators(convertToLlm([user(ts)]));
		const twice = injectTurnBoundarySeparators(once);
		expect(twice).toEqual(once);
	});
});

describe("convertToLlm turn-boundary integration", () => {
	test("injects separators at the convertToLlm boundary", () => {
		const t1 = 1_700_000_000_000;
		const t2 = 1_700_000_100_000;
		const out = convertToLlm([user(t1), assistant(t1 + 1), user(t2)]);
		expect(out).toHaveLength(5);
		expect((out[0].content as { text: string }[])[0].text).toBe(formatTurnBoundary(t1));
		expect((out[3].content as { text: string }[])[0].text).toBe(formatTurnBoundary(t2));
	});
});
