import type { AgentMessage, StreamFn } from "@piki/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@piki/ai";
import type { AssistantMessage, Usage } from "@piki/ai/compat";
import { getModel } from "@piki/ai/compat";
import { COMPACT_MAX_FILE_CHARS, COMPACT_MAX_FILES, OUTPUT_TOKEN_RESERVE } from "@piki/event-core";
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildKeyFilesSection,
	COMPACTION_TIMEOUT_MS,
	type CompactionSettings,
	calculateContextTokens,
	compact,
	computeContinuationCharThreshold,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextChars,
	estimateContextTokens,
	findCutPoint,
	generateBranchSummary,
	generateSummary,
	getLastAssistantUsage,
	prepareCompaction,
	shouldCompact,
} from "../src/core/compaction/index.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type CustomMessageEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "../src/core/session-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

// ============================================================================
// Test fixtures
// ============================================================================

function loadLargeSessionEntries(): SessionEntry[] {
	const sessionPath = join(__dirname, "fixtures/large-session.jsonl");
	const content = readFileSync(sessionPath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries); // Add id/parentId for v1 fixtures
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter() {
	entryCounter = 0;
	lastId = null;
}

// Reset counter before each test to get predictable IDs
beforeEach(() => {
	resetEntryCounter();
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function createCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

function createModelChangeEntry(provider: string, modelId: string): ModelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ModelChangeEntry = {
		type: "model_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
	lastId = id;
	return entry;
}

function createThinkingLevelEntry(thinkingLevel: string): ThinkingLevelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ThinkingLevelChangeEntry = {
		type: "thinking_level_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
	lastId = id;
	return entry;
}

function createCustomMessageEntry(content: string): CustomMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CustomMessageEntry = {
		type: "custom_message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		customType: "test",
		content,
		display: true,
	};
	lastId = id;
	return entry;
}

function extractText(messages: AgentMessage[]): string {
	return messages
		.map((message) => {
			switch (message.role) {
				case "user":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "assistant":
					return message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ");
				case "branchSummary":
				case "compactionSummary":
					return message.summary;
				case "custom":
				case "toolResult":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "bashExecution":
					return `${message.command}\n${message.output}`;
				default:
					return "";
			}
		})
		.join("\n");
}

function extractFirstPromptText(context: Parameters<StreamFn>[1]): string {
	const message = context.messages[0];
	if (!message || !("content" in message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function createPromptCapturingStreamFn(capturedPrompts: string[]): StreamFn {
	return async (_model, context) => {
		capturedPrompts.push(extractFirstPromptText(context));
		return {
			result: async () => createAssistantMessage("summary"),
		} as unknown as Awaited<ReturnType<StreamFn>>;
	};
}

// ============================================================================
// Unit tests
// ============================================================================

describe("Token calculation", () => {
	it("should calculate total context tokens from usage", () => {
		const usage = createMockUsage(1000, 500, 200, 100);
		expect(calculateContextTokens(usage)).toBe(1800);
	});

	it("should handle zero values", () => {
		const usage = createMockUsage(0, 0, 0, 0);
		expect(calculateContextTokens(usage)).toBe(0);
	});
});

describe("getLastAssistantUsage", () => {
	it("should find the last non-aborted assistant message usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(createAssistantMessage("Good", createMockUsage(200, 100))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(200);
	});

	it("should skip aborted messages", () => {
		const abortedMsg: AssistantMessage = {
			...createAssistantMessage("Aborted", createMockUsage(300, 150)),
			stopReason: "aborted",
		};

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(abortedMsg),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(100);
	});

	it("should skip all-zero assistant usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("continue")),
			createMessageEntry(createAssistantMessage("Partial", createMockUsage(0, 0))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(100);
	});

	it("should return undefined if no assistant messages", () => {
		const entries: SessionEntry[] = [createMessageEntry(createUserMessage("Hello"))];
		expect(getLastAssistantUsage(entries)).toBeUndefined();
	});
});

describe("estimateContextTokens", () => {
	it("uses the last non-zero assistant usage as the context anchor", () => {
		const messages: AgentMessage[] = [
			createUserMessage("Hello"),
			createAssistantMessage("Hi", createMockUsage(100, 50)),
			createUserMessage("continue"),
			createAssistantMessage("Partial thinking", createMockUsage(0, 0)),
		];

		const estimate = estimateContextTokens(messages);

		expect(estimate.usageTokens).toBe(150);
		expect(estimate.lastUsageIndex).toBe(1);
		expect(estimate.trailingTokens).toBeGreaterThan(0);
		expect(estimate.tokens).toBe(150 + estimate.trailingTokens);
	});

	it("reports source: 'heuristic' when no usage block exists", () => {
		const messages: AgentMessage[] = [createUserMessage("Hello"), createUserMessage("World")];

		const estimate = estimateContextTokens(messages);

		expect(estimate.source).toBe("heuristic");
		expect(estimate.lastUsageIndex).toBeNull();
		expect(estimate.usageTokens).toBe(0);
	});

	it("reports source: 'usage' when a usage block anchors the estimate", () => {
		const messages: AgentMessage[] = [
			createUserMessage("Hello"),
			createAssistantMessage("Hi", createMockUsage(100, 50)),
		];

		const estimate = estimateContextTokens(messages);

		expect(estimate.source).toBe("usage");
	});
});

describe("estimateContextChars", () => {
	it("estimates continuation resume character size", () => {
		const messages: AgentMessage[] = [createUserMessage("abcd"), createAssistantMessage("efgh")];
		expect(estimateContextChars(messages)).toBeGreaterThanOrEqual(8);
	});
});

describe("shouldCompact", () => {
	it("should return true when context exceeds threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
			keepRatio: 0.1,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(80000, 100000, settings)).toBe(false);
	});

	it("should return false when disabled", () => {
		const settings: CompactionSettings = {
			enabled: false,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
			keepRatio: 0.1,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(false);
	});
});

describe("branch summary reservation", () => {
	it("uses the shared OUTPUT_TOKEN_RESERVE headroom, not the old 16384", () => {
		expect(OUTPUT_TOKEN_RESERVE).toBe(8192);
		// generateBranchSummary falls back to OUTPUT_TOKEN_RESERVE when callers
		// omit reserveTokens, so the branch token budget matches compaction.
		const contextWindow = 128000;
		const tokenBudget = contextWindow - OUTPUT_TOKEN_RESERVE;
		expect(tokenBudget).toBe(contextWindow - 8192);
	});
});

describe("findCutPoint", () => {
	it("should find cut point based on actual token differences", () => {
		// Create entries with cumulative token counts
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(createMessageEntry(createUserMessage(`User ${i}`)));
			entries.push(
				createMessageEntry(createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0))),
			);
		}

		// 20 entries, last assistant has 10000 tokens
		// keepRecentTokens = 2500: keep entries where diff < 2500
		const result = findCutPoint(entries, 0, entries.length, 2500);

		// Should cut at a valid cut point (user or assistant message)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should return startIndex if no valid cut points in range", () => {
		const entries: SessionEntry[] = [createMessageEntry(createAssistantMessage("a"))];
		const result = findCutPoint(entries, 0, entries.length, 1000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should keep everything if all messages fit within budget", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a", createMockUsage(0, 50, 500, 0))),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b", createMockUsage(0, 50, 1000, 0))),
		];

		const result = findCutPoint(entries, 0, entries.length, 50000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should indicate split turn when cutting at assistant message", () => {
		// Create a scenario where we cut at an assistant message mid-turn
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("A1", createMockUsage(0, 100, 1000, 0))),
			createMessageEntry(createUserMessage("Turn 2")), // index 2
			createMessageEntry(createAssistantMessage("A2-1", createMockUsage(0, 100, 5000, 0))), // index 3
			createMessageEntry(createAssistantMessage("A2-2", createMockUsage(0, 100, 8000, 0))), // index 4
			createMessageEntry(createAssistantMessage("A2-3", createMockUsage(0, 100, 10000, 0))), // index 5
		];

		// With keepRecentTokens = 3000, should cut somewhere in Turn 2
		const result = findCutPoint(entries, 0, entries.length, 3000);

		// If cut at assistant message (not user), should indicate split turn
		const cutEntry = entries[result.firstKeptEntryIndex] as SessionMessageEntry;
		if (cutEntry.message.role === "assistant") {
			expect(result.isSplitTurn).toBe(true);
			expect(result.turnStartIndex).toBe(2); // Turn 2 starts at index 2
		}
	});

	it("should budget context-visible custom message entries", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("hi")),
			createMessageEntry(createAssistantMessage("hello")),
			createCustomMessageEntry("x".repeat(4000)),
			createMessageEntry(createAssistantMessage("ok")),
		];

		const tinyBudget = findCutPoint(entries, 0, entries.length, 1);
		expect(tinyBudget.firstKeptEntryIndex).toBe(3);
		expect(tinyBudget.isSplitTurn).toBe(true);
		expect(tinyBudget.turnStartIndex).toBe(2);

		const customFitsBudget = findCutPoint(entries, 0, entries.length, 2);
		expect(customFitsBudget.firstKeptEntryIndex).toBe(2);
		expect(customFitsBudget.isSplitTurn).toBe(false);
		expect(customFitsBudget.turnStartIndex).toBe(-1);
	});
});

describe("buildSessionContext", () => {
	it("should load all messages when no compaction", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a")),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b")),
		];

		const loaded = buildSessionContext(entries);
		expect(loaded.messages.length).toBe(4);
		expect(loaded.thinkingLevel).toBe("off");
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	});

	it("should handle single compaction", () => {
		// IDs: u1=test-id-0, a1=test-id-1, u2=test-id-2, a2=test-id-3, compaction=test-id-4, u3=test-id-5, a3=test-id-6
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const u2 = createMessageEntry(createUserMessage("2"));
		const a2 = createMessageEntry(createAssistantMessage("b"));
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id); // keep from u2 onwards
		const u3 = createMessageEntry(createUserMessage("3"));
		const a3 = createMessageEntry(createAssistantMessage("c"));

		const entries: SessionEntry[] = [u1, a1, u2, a2, compaction, u3, a3];

		const loaded = buildSessionContext(entries);
		// summary + kept (u2, a2) + after (u3, a3) = 5
		expect(loaded.messages.length).toBe(5);
		expect(loaded.messages[0].role).toBe("compactionSummary");
		expect((loaded.messages[0] as any).summary).toContain("Summary of 1,a,2,b");
	});

	it("should handle multiple compactions (only latest matters)", () => {
		// First batch
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id);
		// Second batch
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));
		const u3 = createMessageEntry(createUserMessage("3"));
		const c = createMessageEntry(createAssistantMessage("c"));
		const compact2 = createCompactionEntry("Second summary", u3.id); // keep from u3 onwards
		// After second compaction
		const u4 = createMessageEntry(createUserMessage("4"));
		const d = createMessageEntry(createAssistantMessage("d"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b, u3, c, compact2, u4, d];

		const loaded = buildSessionContext(entries);
		// summary + kept from u3 (u3, c) + after (u4, d) = 5
		expect(loaded.messages.length).toBe(5);
		expect((loaded.messages[0] as any).summary).toContain("Second summary");
	});

	it("should keep all messages when firstKeptEntryId is first entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id); // keep from first entry
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b];

		const loaded = buildSessionContext(entries);
		// summary + all messages (u1, a1, u2, b) = 5
		expect(loaded.messages.length).toBe(5);
	});

	it("should track model and thinking level changes", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createModelChangeEntry("openai", "gpt-4"),
			createMessageEntry(createAssistantMessage("a")),
			createThinkingLevelEntry("high"),
		];

		const loaded = buildSessionContext(entries);
		// model_change is later overwritten by assistant message's model info
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(loaded.thinkingLevel).toBe("high");
	});
});

describe("prepareCompaction with previous compaction", () => {
	it("should skip repeated compactions when kept messages still fit", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1"));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2"));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1"));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3", createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1)"));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4", createMockUsage(8000, 2000)));

		const pathEntries = [u1, a1, u2, a2, u3, a3, compaction1, u4, a4];
		const preparation = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeUndefined();
	});

	it("should re-summarize previously kept messages when the recent window moves past them", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)".repeat(4)));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1".repeat(4)));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1 ".repeat(12)));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2 ".repeat(12)));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1 ".repeat(12)));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3 ".repeat(12), createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1) ".repeat(12)));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4 ".repeat(12), createMockUsage(8000, 2000)));

		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 100,
		};
		const preparation = prepareCompaction([u1, a1, u2, a2, u3, a3, compaction1, u4, a4], settings);

		expect(preparation).toBeDefined();
		const summarizedText = extractText(preparation!.messagesToSummarize);
		expect(summarizedText).toContain("user msg 2 - kept by compaction1");
		expect(summarizedText).toContain("user msg 3 - kept by compaction1");
		expect(summarizedText).not.toContain("First summary");
		expect(preparation!.previousSummary).toBe("First summary");
	});
});

describe("summarization prompts", () => {
	it("instructs compaction summaries to preserve failed attempts and blockers", async () => {
		const capturedPrompts: string[] = [];
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		await generateSummary(
			[createUserMessage("continue after npm run check failed")],
			model,
			DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
			createPromptCapturingStreamFn(capturedPrompts),
		);

		expect(capturedPrompts[0]).toContain("## Reflection");
		expect(capturedPrompts[0]).toContain("## Critical Context");
		expect(capturedPrompts[0]).toContain("What to avoid repeating");
	});

	it("instructs updated summaries to preserve prior negative results", async () => {
		const capturedPrompts: string[] = [];
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		await generateSummary(
			[createUserMessage("new messages")],
			model,
			DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			undefined,
			undefined,
			undefined,
			undefined,
			"previous summary",
			"off",
			createPromptCapturingStreamFn(capturedPrompts),
		);

		expect(capturedPrompts[0]).toContain("## Reflection");
		expect(capturedPrompts[0]).toContain("Preserve previous reflection content");
		expect(capturedPrompts[0]).toContain("<previous-summary>");
	});

	it("instructs branch summaries to preserve negative results", async () => {
		const capturedPrompts: string[] = [];
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const result = await generateBranchSummary([createMessageEntry(createUserMessage("branch failed"))], {
			model,
			apiKey: "test-key",
			signal: new AbortController().signal,
			streamFn: createPromptCapturingStreamFn(capturedPrompts),
		});

		expect(result.summary).toContain("summary");
		expect(capturedPrompts[0]).toContain("Preserve failed attempts, negative results");
		expect(capturedPrompts[0]).toContain("Do not mark work as done unless");
		expect(capturedPrompts[0]).toContain("Preserve exact validation commands and outcomes");
	});
});

// ============================================================================
// Integration tests with real session data
// ============================================================================

describe("Large session fixture", () => {
	it("should parse the large session", () => {
		const entries = loadLargeSessionEntries();
		expect(entries.length).toBeGreaterThan(100);

		const messageCount = entries.filter((e) => e.type === "message").length;
		expect(messageCount).toBeGreaterThan(100);
	});

	it("should find cut point in large session", () => {
		const entries = loadLargeSessionEntries();
		const result = findCutPoint(entries, 0, entries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens ?? 20000);

		// Cut point should be at a message entry (user or assistant)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should load session correctly", () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);

		expect(loaded.messages.length).toBeGreaterThan(100);
		expect(loaded.model).not.toBeNull();
	});
});

// ============================================================================
// Key-file inlining
// ============================================================================

describe("buildKeyFilesSection", () => {
	const createdFiles: string[] = [];
	const originalCwd = process.cwd();

	beforeEach(() => {
		for (const f of createdFiles) {
			try {
				unlinkSync(f);
			} catch {
				// ignore
			}
		}
		createdFiles.length = 0;
	});

	afterAll(() => {
		process.chdir(originalCwd);
		for (const f of createdFiles) {
			try {
				unlinkSync(f);
			} catch {
				// ignore
			}
		}
	});

	function writeTempFile(name: string, contents: string): string {
		const abs = join(originalCwd, name);
		writeFileSync(abs, contents, "utf-8");
		createdFiles.push(abs);
		return name; // path relative to cwd, where tests run from originalCwd
	}

	it("returns empty string when there are no file operations", async () => {
		const fileOps = createFileOps();
		const result = await buildKeyFilesSection(fileOps, originalCwd);
		expect(result).toBe("");
	});

	it("inlines file contents under a ## Key Files block", async () => {
		const name = writeTempFile("piki-kf-a.txt", "hello world");
		const fileOps = createFileOps();
		fileOps.read.add(name);
		const result = await buildKeyFilesSection(fileOps, originalCwd);
		expect(result).toContain("## Key Files");
		expect(result).toContain(`### ${name}`);
		expect(result).toContain("hello world");
	});

	it("skips paths that cannot be read", async () => {
		const fileOps = createFileOps();
		fileOps.read.add("piki-kf-does-not-exist.txt");
		const result = await buildKeyFilesSection(fileOps, originalCwd);
		expect(result).toBe("");
	});

	it("truncates files longer than COMPACT_MAX_FILE_CHARS", async () => {
		const big = "x".repeat(COMPACT_MAX_FILE_CHARS + 500);
		const name = writeTempFile("piki-kf-big.txt", big);
		const fileOps = createFileOps();
		fileOps.edited.add(name);
		const result = await buildKeyFilesSection(fileOps, originalCwd);
		// The inlined block must not contain the full length; truncation drops the tail.
		expect(result).not.toContain(big);
		expect(result).toContain("## Key Files");
	});

	it("caps inlined files at COMPACT_MAX_FILES", async () => {
		const fileOps = createFileOps();
		for (let i = 0; i < COMPACT_MAX_FILES + 5; i++) {
			const name = writeTempFile(`piki-kf-c${i}.txt`, `content-${i}`);
			fileOps.written.add(name);
		}
		const result = await buildKeyFilesSection(fileOps, originalCwd);
		const blockCount = (result.match(/### /g) ?? []).length;
		expect(blockCount).toBe(COMPACT_MAX_FILES);
	});
});

// ============================================================================
// LLM integration tests (skipped without API key)
// ============================================================================

describe.skipIf(!process.env.ANTHROPIC_OAUTH_TOKEN)("LLM summarization", () => {
	it("should generate a compaction result for the large session", async () => {
		const entries = loadLargeSessionEntries();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_OAUTH_TOKEN!);

		expect(compactionResult.summary.length).toBeGreaterThan(100);
		expect(compactionResult.firstKeptEntryId).toBeTruthy();
		expect(compactionResult.tokensBefore).toBeGreaterThan(0);

		console.log("Summary length:", compactionResult.summary.length);
		console.log("First kept entry ID:", compactionResult.firstKeptEntryId);
		console.log("Tokens before:", compactionResult.tokensBefore);
		console.log("\n--- SUMMARY ---\n");
		console.log(compactionResult.summary);
	}, 60000);

	it("should produce valid session after compaction", async () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_OAUTH_TOKEN!);

		// Simulate appending compaction to entries by creating a proper entry
		const lastEntry = entries[entries.length - 1];
		const parentId = lastEntry.id;
		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: "compaction-test-id",
			parentId,
			timestamp: new Date().toISOString(),
			...compactionResult,
		};
		const newEntries = [...entries, compactionEntry];
		const reloaded = buildSessionContext(newEntries);

		// Should have summary + kept messages
		expect(reloaded.messages.length).toBeLessThan(loaded.messages.length);
		expect(reloaded.messages[0].role).toBe("compactionSummary");
		expect((reloaded.messages[0] as any).summary).toContain(compactionResult.summary);

		console.log("Original messages:", loaded.messages.length);
		console.log("After compaction:", reloaded.messages.length);
	}, 60000);
});

// ============================================================================
// Crash-proof compaction lifecycle (mrkkpimo root cause)
// ============================================================================

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
	_compactionAbortController?: unknown;
};

describe("computeContinuationCharThreshold scaling", () => {
	it("returns at least the legacy 100k floor for small windows", () => {
		expect(computeContinuationCharThreshold(undefined)).toBeGreaterThanOrEqual(100_000);
		expect(computeContinuationCharThreshold(100_000)).toBeGreaterThanOrEqual(100_000);
		expect(computeContinuationCharThreshold(200_000)).toBeGreaterThanOrEqual(100_000);
	});

	it("scales upward for a 1M window (~0.9 * (1M - 8192) * 4 chars)", () => {
		const scaled = computeContinuationCharThreshold(1_000_000);
		expect(scaled).toBeGreaterThan(100_000);
		// 0.9 * (1_000_000 - 8192) * 4 ≈ 3_589_708
		expect(scaled).toBe(Math.max(100_000, Math.floor((1_000_000 * 4 - 8192 * 4) * 0.9)));
		expect(scaled).toBeGreaterThan(3_000_000);
	});
});

describe("crash-proof compaction lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function buildHarnessWithHistory(
		keepRecentTokens = 1,
		extensionFactories?: HarnessOptions["extensionFactories"],
	): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }],
			settings: { compaction: { enabled: true, keepRecentTokens } },
			extensionFactories,
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		return harness;
	}

	it("captures the compact tool call during auto-compaction", async () => {
		const harness = await buildHarnessWithHistory();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("compact", {
					summary: "captured summary",
					reflection: "captured reflection",
					files: [],
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(internals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		const compaction = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction") as
			| CompactionEntry
			| undefined;
		expect(compaction?.summary).toBe("captured summary");
		expect(compaction?.details).toMatchObject({
			reflection: "captured reflection",
			readFiles: [],
		});
	});

	it("retries until the compact tool is called", async () => {
		const harness = await buildHarnessWithHistory();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("not compact"),
			fauxAssistantMessage("still not compact"),
			fauxAssistantMessage(
				fauxToolCall("compact", { summary: "third attempt", reflection: "retry worked", files: [] }),
				{ stopReason: "toolUse" },
			),
		]);
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(internals._runAutoCompaction("threshold", false)).resolves.toBe(false);
		expect(harness.faux.state.callCount).toBe(5);
		const compaction = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction") as
			| CompactionEntry
			| undefined;
		expect(compaction?.summary).toBe("third attempt");
	});

	it("emits compaction_end for every compaction_start (success path)", async () => {
		const harness = await buildHarnessWithHistory(1, [
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "success summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		]);
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		const startsBefore = harness.eventsOfType("compaction_start").length;
		const endsBefore = harness.eventsOfType("compaction_end").length;

		await internals._runAutoCompaction("threshold", false);

		const starts = harness.eventsOfType("compaction_start");
		const ends = harness.eventsOfType("compaction_end");
		expect(starts.length).toBe(startsBefore + 1);
		expect(ends.length).toBe(endsBefore + 1);
		expect(starts.at(-1)).toMatchObject({ type: "compaction_start", reason: "threshold" });
		expect(ends.at(-1)).toMatchObject({ type: "compaction_end", reason: "threshold", aborted: false });
		// Controller must be cleared so a subsequent compaction can run.
		expect(internals._compactionAbortController).toBeUndefined();
	});

	it("emits compaction_end on summarization failure (extractive fallback)", async () => {
		const harness = await buildHarnessWithHistory();
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		// Force the summarization LLM call to reject so the catch/fallback path runs.
		(harness.session.agent as { streamFn: StreamFn }).streamFn = () => {
			throw new Error("summarization provider hang");
		};

		const startsBefore = harness.eventsOfType("compaction_start").length;
		await expect(internals._runAutoCompaction("overflow", true)).resolves.toBe(false);

		const starts = harness.eventsOfType("compaction_start");
		const ends = harness.eventsOfType("compaction_end");
		expect(starts.length).toBe(startsBefore + 1);
		expect(ends.length).toBe(startsBefore + 1);
		expect(ends.at(-1)).toMatchObject({ type: "compaction_end" });
		expect(internals._compactionAbortController).toBeUndefined();
	});

	it("degrades to extractive tail-keep fallback when in-flight compaction is aborted", async () => {
		const harness = await buildHarnessWithHistory();
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		// A summarization stream that never resolves on its own but honors the
		// abort signal (as the real provider stream would). This simulates a
		// provider call hung until the per-compaction timeout fires.
		(harness.session.agent as { streamFn: StreamFn }).streamFn = ((_model, _ctx, options) =>
			new Promise<never>((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
			})) as StreamFn;

		const startsBefore = harness.eventsOfType("compaction_start").length;
		const compactPromise = internals._runAutoCompaction("threshold", false);
		// Mimic the 60s COMPACTION_TIMEOUT_MS abort firing immediately.
		setTimeout(() => harness.session.abortCompaction(), 0);
		await compactPromise;

		const starts = harness.eventsOfType("compaction_start");
		const ends = harness.eventsOfType("compaction_end");
		expect(starts.length).toBe(startsBefore + 1);
		expect(ends.length).toBe(startsBefore + 1);
		// A terminal event must exist without raising the timeout wall.
		expect(ends.at(-1)).toMatchObject({ type: "compaction_end" });
		expect(internals._compactionAbortController).toBeUndefined();
	});

	it("exposes a configurable per-compaction timeout constant", () => {
		expect(COMPACTION_TIMEOUT_MS).toBe(60_000);
	});
});
