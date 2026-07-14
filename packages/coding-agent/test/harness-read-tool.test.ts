import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createReadAgentTool, defineReadHarnessTool, FsErrorSchema } from "../src/core/harness/tools/read.ts";

describe("read harness tool — parity", () => {
	let tempDir: string;
	let scratchpadDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "piki-read-test-"));
		scratchpadDir = mkdtempSync(join(tmpdir(), "piki-read-scratch-"));
		// Write a known file
		writeFileSync(join(tempDir, "sample.txt"), "line1\nline2\nline3\nline4\nline5", "utf-8");
		writeFileSync(join(tempDir, "ten.txt"), Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n"), "utf-8");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(scratchpadDir, { recursive: true, force: true });
	});

	test("reads a text file and returns a plain string", async () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "sample.txt" }));
		expect(typeof result).toBe("string");
		expect(result).toContain("line1");
		expect(result).toContain("line5");
	});

	test("respects offset (1-indexed) and limit", async () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "ten.txt", offset: 3, limit: 2 }));
		const lines = result.split("\n");
		// Should contain L3 and L4 (2 lines), then suffix
		expect(lines[0]).toBe("L3");
		expect(lines[1]).toBe("L4");
		// 10 total lines, startIdx=2, endIdx=4, remaining = 10 - 4 = 6
		expect(result).toContain("6 more lines remaining");
		expect(result).toContain("Use offset=5 to continue reading.");
	});

	test("appends exact suffix format when lines remain", async () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		// 10 lines, offset=1, limit=3 → slice=L1,L2,L3, remaining=7, nextOffset=4
		const result = await Effect.runPromise(tool.execute({ path: "ten.txt", offset: 1, limit: 3 }));
		const expectedSuffix = "\n... (7 more lines remaining. Use offset=4 to continue reading.)";
		expect(result.endsWith(expectedSuffix)).toBe(true);
	});

	test("does not append suffix when all lines consumed", async () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		// 10 lines, offset=1, limit=20 → all 10 lines, remaining = 10 - 20 = -10 (not > 0)
		const result = await Effect.runPromise(tool.execute({ path: "ten.txt", offset: 1, limit: 20 }));
		expect(result).not.toContain("more lines remaining");
		expect(result).toBe(Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n"));
	});

	test("fails with FsError when offset < 1", async () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		try {
			await Effect.runPromise(tool.execute({ path: "sample.txt", offset: 0 }));
			expect.fail("should have thrown");
		} catch (err: any) {
			expect(err._tag).toBe("FsError");
			expect(err.message).toBe("offset must be >= 1");
		}
	});

	test("fails with FsError when offset > total lines", async () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		try {
			await Effect.runPromise(tool.execute({ path: "sample.txt", offset: 100 }));
			expect.fail("should have thrown");
		} catch (err: any) {
			expect(err._tag).toBe("FsError");
			expect(err.message).toBe("offset 100 exceeds total lines 5");
		}
	});

	test("fails with FsError 'Failed to read' when file doesn't exist", async () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		try {
			await Effect.runPromise(tool.execute({ path: "nonexistent-file.xyz" }));
			expect.fail("should have thrown");
		} catch (err: any) {
			expect(err._tag).toBe("FsError");
			expect(err.message).toBe("Failed to read nonexistent-file.xyz");
		}
	});

	test("$M/ prefix expands to scratchpadPath", async () => {
		// Write a file in the scratchpad dir
		writeFileSync(join(scratchpadDir, "note.md"), "# Scratchpad Note\nHello from scratchpad", "utf-8");
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "$M/note.md" }));
		expect(typeof result).toBe("string");
		expect(result).toContain("Hello from scratchpad");
	});

	test("HarnessTool definition has outputSchema: Schema.String", () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		expect(tool.definition.outputSchema).toBe(Schema.String);
	});

	test("HarnessTool definition has name 'read' and inputSchema", () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		expect(tool.definition.name).toBe("read");
		expect(tool.definition.inputSchema).toBeDefined();
	});

	test("HarnessTool has errorSchema with _tag FsError", () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		expect(tool.errorSchema).toBeDefined();
		expect(tool.errorSchema).toBe(FsErrorSchema);
	});

	test("HarnessTool has a stream handler", () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		expect(tool.stream).toBeDefined();
		expect(typeof tool.stream?.onInput).toBe("function");
	});

	test("stream.onInput throws StreamValidationError for missing file", () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		expect(() => {
			tool.stream?.onInput?.({ path: "does-not-exist.txt" });
		}).toThrow();
	});

	test("stream.onInput does not throw for existing file", () => {
		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		expect(() => {
			tool.stream?.onInput?.({ path: "sample.txt" });
		}).not.toThrow();
	});

	test("createReadAgentTool produces a working AgentTool", async () => {
		const harnessTool = defineReadHarnessTool(tempDir, scratchpadDir);
		const agentTool = createReadAgentTool(harnessTool);
		expect(agentTool.name).toBe("read");
		expect(agentTool.parameters).toBeDefined();

		const result = await agentTool.execute("test-id", { path: "sample.txt" }, undefined, undefined);
		expect(result.content.length).toBeGreaterThanOrEqual(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("line1");
		// details should be the raw string output
		expect(result.details).toBe((result.content[0] as any).text);
	});

	test("default limit is 2000", async () => {
		// Create a file with 2500 lines (no trailing newline → split gives exactly 2500)
		const bigContent = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n");
		writeFileSync(join(tempDir, "big.txt"), bigContent, "utf-8");

		const tool = defineReadHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "big.txt" }));
		// 2500 lines, default limit 2000 → slice 2000 lines, remaining = 500
		expect(result).toContain("500 more lines remaining");
		expect(result).toContain("Use offset=2001 to continue reading.");
		// The slice should contain line1 and line2000 but not line2001
		expect(result).toContain("line1");
		expect(result).toContain("line2000");
		expect(result.split("\n")[0]).toBe("line1");
	});
});
