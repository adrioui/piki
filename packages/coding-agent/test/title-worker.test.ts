import { describe, expect, it } from "vitest";
import type { ReadonlySessionManager } from "../src/core/session-manager.ts";
import { deterministicTitle, extractFirstUserText, type TitleWorkerEvent } from "../src/core/title-worker.ts";

function makeMockSessionManager(
	entries: Array<{ type: string; message?: { role: string; content: unknown } }>,
): ReadonlySessionManager {
	return {
		getHeader: () => null,
		getEntries: () => entries as never[],
		getTree: () => [],
		getLeafId: () => null,
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getBranch: () => [],
		getCwd: () => "/test",
		getSessionDir: () => "/test/sessions",
		getSessionId: () => "test-id",
		getSessionFile: () => "/test/session.jsonl",
		getSessionName: () => undefined,
	} as unknown as ReadonlySessionManager;
}

describe("title-worker", () => {
	describe("deterministicTitle", () => {
		it("should extract first sentence", () => {
			expect(deterministicTitle("Fix the login bug. It crashes on submit.")).toBe("Fix the login bug");
		});

		it("should handle text without sentence enders", () => {
			expect(deterministicTitle("add dark mode")).toBe("Add dark mode");
		});

		it("should truncate long text at 80 chars", () => {
			const longText = "a".repeat(100);
			const result = deterministicTitle(longText);
			expect(result.length).toBeLessThanOrEqual(80);
		});

		it("should handle empty text", () => {
			expect(deterministicTitle("")).toBe("Untitled session");
		});

		it("should handle whitespace-only text", () => {
			expect(deterministicTitle("   ")).toBe("Untitled session");
		});

		it("should capitalize first letter", () => {
			expect(deterministicTitle("refactor database layer")).toBe("Refactor database layer");
		});

		it("should strip leading special characters", () => {
			expect(deterministicTitle("--- fix the bug")).toBe("Fix the bug");
		});

		it("should handle newlines as sentence enders", () => {
			expect(deterministicTitle("Fix login\nthen deploy")).toBe("Fix login");
		});

		it("should handle question marks", () => {
			expect(deterministicTitle("Why is the build failing?")).toBe("Why is the build failing");
		});

		it("should handle exclamation marks", () => {
			expect(deterministicTitle("Deploy to production!")).toBe("Deploy to production");
		});
	});

	describe("extractFirstUserText", () => {
		it("should extract text from string content", () => {
			const sm = makeMockSessionManager([{ type: "message", message: { role: "user", content: "Hello world" } }]);
			expect(extractFirstUserText(sm)).toBe("Hello world");
		});

		it("should extract text from array content", () => {
			const sm = makeMockSessionManager([
				{
					type: "message",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "Hello" },
							{ type: "text", text: "world" },
						],
					},
				},
			]);
			expect(extractFirstUserText(sm)).toBe("Hello world");
		});

		it("should skip assistant messages", () => {
			const sm = makeMockSessionManager([
				{ type: "message", message: { role: "assistant", content: "I am assistant" } },
				{ type: "message", message: { role: "user", content: "User message" } },
			]);
			expect(extractFirstUserText(sm)).toBe("User message");
		});

		it("should return undefined when no user messages", () => {
			const sm = makeMockSessionManager([{ type: "message", message: { role: "assistant", content: "No user" } }]);
			expect(extractFirstUserText(sm)).toBeUndefined();
		});

		it("should return undefined for empty entries", () => {
			const sm = makeMockSessionManager([]);
			expect(extractFirstUserText(sm)).toBeUndefined();
		});

		it("should handle image-only content", () => {
			const sm = makeMockSessionManager([
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "image", url: "https://example.com/img.png" }],
					},
				},
			]);
			expect(extractFirstUserText(sm)).toBeUndefined();
		});
	});

	describe("TitleWorkerEvent types", () => {
		it("should have valid event type shapes", () => {
			const startEvent: TitleWorkerEvent = {
				type: "title_generate_start",
				method: "llm",
				firstUserText: "test",
			};
			const endEvent: TitleWorkerEvent = {
				type: "title_generate_end",
				title: "Test Title",
				method: "llm",
				durationMs: 100,
			};
			const errorEvent: TitleWorkerEvent = {
				type: "title_generate_error",
				error: "timeout",
				fallbackTitle: "Fallback",
				durationMs: 50,
			};
			expect(startEvent.type).toBe("title_generate_start");
			expect(endEvent.type).toBe("title_generate_end");
			expect(errorEvent.type).toBe("title_generate_error");
		});
	});
});
