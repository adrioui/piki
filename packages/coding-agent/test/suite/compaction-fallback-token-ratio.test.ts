import type { AgentMessage } from "@piki/agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Message,
	type Model,
} from "@piki/ai";
import { COMPACTION_FALLBACK_KEEP_RATIO } from "@piki/event-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSoftCap, estimateTokens } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Wave-6 P6: extractive tail-keep fallback must use a softCap-token budget
 * (mag: `fallbackBudget = softCap * 0.25`) over raw session entries, walking
 * backwards, and must NOT inject the synthetic "[Context overflow ...]" note.
 * The prior implementation used a message-COUNT fraction (25% of messages) and
 * injected a note — this verifies the token-budget rewrite.
 */

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "threshold" | "overflow", willRetry: boolean) => Promise<boolean>;
};

const NOTE_MARKERS = ["[Context overflow", "earlier messages were removed to stay within"];

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(harness: Harness, tokens: number): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", { stopReason: "stop" }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(tokens),
	};
}

function userText(text: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as Message;
}

// softCap = min(floor((12000-8192)*0.9), 200000) = 3427;
// budget = 3427 * 0.25 ≈ 856 tokens.
const SMALL_CONTEXT = 12000;

function getText(message: AgentMessage | undefined): string {
	if (!message || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

describe("compaction fallback uses softCap token budget (P6)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps ~25% of softCap in tokens over raw entries and injects no note", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);

		// Override the model's context window so the softCap-derived budget is
		// small and deterministic.
		const smallModel: Model<string> = {
			...harness.getModel(),
			contextWindow: SMALL_CONTEXT,
		} as Model<string>;
		harness.session.agent.state.model = smallModel;

		// Leading task message (entry[0]) — must always survive as leading context.
		harness.sessionManager.appendMessage(userText("initial task"));

		// 15 uniform entries, each ~100 tokens (400 chars). After the leading
		// entry there are 15 entries; a count-fraction fallback would keep
		// floor(16 * 0.25) = 4 messages. The token budget keeps ~8 entries.
		const entryText = "x".repeat(400);
		for (let i = 0; i < 15; i++) {
			harness.sessionManager.appendMessage(userText(entryText));
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		// Make the summarization LLM turn return a plain stop with no `compact`
		// tool call, so _runAutoCompaction falls through to the extractive fallback.
		harness.session.agent.streamFn = (_model) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: assistant(harness, 10) });
			});
			return stream;
		};

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		await sessionInternals._runAutoCompaction("threshold", false);

		const messages = harness.session.messages;
		const softCap = computeSoftCap(SMALL_CONTEXT);
		const budget = softCap * COMPACTION_FALLBACK_KEEP_RATIO;

		// 1) Leading entry preserved.
		expect(messages[0]?.role).toBe("user");
		expect(getText(messages[0])).toBe("initial task");

		// 2) No synthetic note injected.
		for (const message of messages) {
			const text = getText(message);
			for (const marker of NOTE_MARKERS) {
				expect(text).not.toContain(marker);
			}
		}

		// 3) Token-budget (not count) semantics: kept tail entries are bounded by
		// budget and differ from the count-fraction result (4).
		const keptTail = messages.slice(1);
		const keptTailTokens = keptTail.reduce((sum, message) => sum + estimateTokens(message), 0);
		expect(keptTail.length).toBeGreaterThan(Math.floor(messages.length * COMPACTION_FALLBACK_KEEP_RATIO));
		expect(keptTail.length).toBeGreaterThan(4); // count-fraction would keep 4
		// Tail fits within budget plus the slack of a single kept entry.
		expect(keptTailTokens).toBeLessThanOrEqual(budget + 100 + estimateTokens(keptTail[0]!));

		// 4) A compaction entry was recorded as a fallback.
		const compactionEntries = harness.sessionManager.getEntries().filter((e) => e.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect((compactionEntries[0] as { details?: { fallback?: boolean } }).details?.fallback).toBe(true);
	});
});
