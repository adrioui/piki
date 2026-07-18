import { describe, expect, test } from "vitest";
import { classifyToolError, createTimeoutToolResult, ToolTimeoutError } from "../src/tool-errors.ts";

describe("classifyToolError", () => {
	test("timeout category when timedOutMs provided", () => {
		const info = classifyToolError(new Error("whatever"), { toolName: "shell", timedOutMs: 120_000 });
		expect(info.category).toBe("timeout");
		expect(info.timedOutMs).toBe(120_000);
		expect(info.retryable).toBe(false);
		expect(info.message).toContain("shell");
	});

	test("aborted category for AbortError", () => {
		const err = new DOMException("aborted", "AbortError");
		expect(classifyToolError(err, { toolName: "read" }).category).toBe("aborted");
	});

	test("permission category", () => {
		const info = classifyToolError(new Error("EACCES: permission denied"), { toolName: "read" });
		expect(info.category).toBe("permission");
		expect(info.retryable).toBe(false);
		expect(info.hint).toMatch(/permitted|approval/i);
	});

	test("filesystem category for ENOENT", () => {
		const info = classifyToolError(new Error("ENOENT: no such file or directory"), { toolName: "read" });
		expect(info.category).toBe("filesystem");
		expect(info.retryable).toBe(false);
	});

	test("network category is retryable", () => {
		const info = classifyToolError(new Error("fetch failed: ETIMEDOUT"), { toolName: "web_fetch" });
		expect(info.category).toBe("network");
		expect(info.retryable).toBe(true);
	});

	test("invalid_args category", () => {
		const info = classifyToolError(new Error("invalid arguments: 'path' is required"), { toolName: "edit" });
		expect(info.category).toBe("invalid_args");
		expect(info.retryable).toBe(false);
	});

	test("unknown category is the fallback", () => {
		const info = classifyToolError(new Error("weird gremlin failure"), { toolName: "grep" });
		expect(info.category).toBe("unknown");
		expect(info.retryable).toBe(false);
	});
});

describe("ToolTimeoutError + createTimeoutToolResult", () => {
	test("timeout result carries structured toolError info", () => {
		const result = createTimeoutToolResult("shell", 120_000);
		expect(result.content[0].text).toContain("timed out");
		expect(result.details.toolError.category).toBe("timeout");
		expect(result.details.toolError.timedOutMs).toBe(120_000);
	});

	test("ToolTimeoutError exposes the deadline", () => {
		const err = new ToolTimeoutError(30_000);
		expect(err.timedOutMs).toBe(30_000);
		expect(err.name).toBe("ToolTimeoutError");
	});
});
