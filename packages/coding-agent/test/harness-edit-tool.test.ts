import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	createEditAgentTool,
	defineEditHarnessTool,
	EditEmissionSchema,
	editParameters,
	FsErrorSchema,
	validateAndApply,
} from "../src/core/harness/tools/edit.ts";

describe("edit harness tool — parity", () => {
	let tempDir: string;
	let scratchpadDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "piki-edit-test-"));
		scratchpadDir = mkdtempSync(join(tmpdir(), "piki-edit-scratch-"));
		writeFileSync(join(tempDir, "sample.txt"), "line1\nline2\nline3\nline4\nline5", "utf-8");
		writeFileSync(join(tempDir, "dups.txt"), "foo\nbar\nfoo\nbar\nfoo", "utf-8");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(scratchpadDir, { recursive: true, force: true });
	});

	test("replaces exact text and returns summary string", async () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "sample.txt", old: "line2", new: "LINE_TWO" }));
		expect(typeof result).toBe("string");
		expect(result).toBe("Replaced 1 line(s) with 1 line(s) in sample.txt");
		const written = readFileSync(join(tempDir, "sample.txt"), "utf-8");
		expect(written).toBe("line1\nLINE_TWO\nline3\nline4\nline5");
	});

	test("replaces multi-line block", async () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(
			tool.execute({ path: "sample.txt", old: "line2\nline3", new: "REPLACED" }),
		);
		expect(result).toBe("Replaced 2 line(s) with 1 line(s) in sample.txt");
		const written = readFileSync(join(tempDir, "sample.txt"), "utf-8");
		expect(written).toBe("line1\nREPLACED\nline4\nline5");
	});

	test("deletes lines when new is empty string", async () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "sample.txt", old: "line3\n", new: "" }));
		expect(result).toBe("Deleted 2 line(s) from sample.txt");
	});

	test("fails with FsError when old not found", async () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		try {
			await Effect.runPromise(tool.execute({ path: "sample.txt", old: "nonexistent text", new: "x" }));
			expect.fail("should have thrown");
		} catch (err: any) {
			expect(err._tag).toBe("FsError");
			expect(err.message).toBe('"old" parameter content not found in file. Ensure it matches the file exactly.');
		}
	});

	test("fails with FsError when old is empty", async () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		try {
			await Effect.runPromise(tool.execute({ path: "sample.txt", old: "", new: "x" }));
			expect.fail("should have thrown");
		} catch (err: any) {
			expect(err._tag).toBe("FsError");
			expect(err.message).toBe('"old" parameter content must not be empty.');
		}
	});

	test("fails with FsError on multiple matches without replaceAll", async () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		try {
			await Effect.runPromise(tool.execute({ path: "dups.txt", old: "foo", new: "FOO" }));
			expect.fail("should have thrown");
		} catch (err: any) {
			expect(err._tag).toBe("FsError");
			expect(err.message).toContain("matches 3 locations");
		}
	});

	test("replaceAll replaces all occurrences", async () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(
			tool.execute({ path: "dups.txt", old: "foo", new: "FOO", replaceAll: true }),
		);
		expect(result).toBe("Replaced 3 occurrences in dups.txt");
		const written = readFileSync(join(tempDir, "dups.txt"), "utf-8");
		expect(written).toBe("FOO\nbar\nFOO\nbar\nFOO");
	});

	test("$M/ prefix expands to scratchpadPath", async () => {
		writeFileSync(join(scratchpadDir, "note.md"), "# Title\nbody text", "utf-8");
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "$M/note.md", old: "# Title", new: "# New Title" }));
		expect(result).toBe("Replaced 1 line(s) with 1 line(s) in $M/note.md");
		const written = readFileSync(join(scratchpadDir, "note.md"), "utf-8");
		expect(written).toBe("# New Title\nbody text");
	});

	test("fails with FsError 'Failed to read' when file doesn't exist", async () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		try {
			await Effect.runPromise(tool.execute({ path: "nonexistent.txt", old: "x", new: "y" }));
			expect.fail("should have thrown");
		} catch (err: any) {
			expect(err._tag).toBe("FsError");
			expect(err.message).toBe("Failed to read nonexistent.txt");
		}
	});

	test("HarnessTool definition has outputSchema: Schema.String", () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		expect(tool.definition.outputSchema).toBe(Schema.String);
	});

	test("HarnessTool definition has name 'edit'", () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		expect(tool.definition.name).toBe("edit");
	});

	test("HarnessTool has errorSchema with _tag FsError", () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		expect(tool.errorSchema).toBeDefined();
		expect(tool.errorSchema).toBe(FsErrorSchema);
	});

	test("emissionSchema is structurally correct", () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		expect(tool.emissionSchema).toBeDefined();
		expect(tool.emissionSchema).toBe(EditEmissionSchema);
	});

	test("HarnessTool has a stream handler", () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		expect(tool.stream).toBeDefined();
		expect(typeof tool.stream?.onInput).toBe("function");
	});

	test("stream.onInput throws StreamValidationError for missing file", () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		expect(() => {
			tool.stream?.onInput?.({ path: "does-not-exist.txt" });
		}).toThrow();
	});

	test("stream.onInput does not throw for existing file", () => {
		const tool = defineEditHarnessTool(tempDir, scratchpadDir);
		expect(() => {
			tool.stream?.onInput?.({ path: "sample.txt" });
		}).not.toThrow();
	});

	test("TypeBox parameters match expected structure", () => {
		expect(editParameters).toBeDefined();
		const props = (editParameters as any).properties;
		expect(props).toBeDefined();
		expect(props.path).toBeDefined();
		expect(props.old).toBeDefined();
		expect(props.new).toBeDefined();
		expect(props.replaceAll).toBeDefined();
	});

	test("createEditAgentTool produces a working AgentTool", async () => {
		const harnessTool = defineEditHarnessTool(tempDir, scratchpadDir);
		const agentTool = createEditAgentTool(harnessTool);
		expect(agentTool.name).toBe("edit");
		expect(agentTool.parameters).toBeDefined();

		const result = await agentTool.execute(
			"test-id",
			{ path: "sample.txt", old: "line1", new: "LINE_ONE" },
			undefined,
			undefined,
		);
		expect(result.content.length).toBeGreaterThanOrEqual(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("Replaced");
	});

	// --- validateAndApply unit tests ---

	test("validateAndApply: single replacement", () => {
		const result = validateAndApply("abc\nDEF\nghi", "DEF", "XYZ", false);
		expect(result.result).toBe("abc\nXYZ\nghi");
		expect(result.replaceCount).toBe(1);
		expect(result.startLine).toBe(2);
		expect(result.removedLines).toEqual(["DEF"]);
		expect(result.addedLines).toEqual(["XYZ"]);
	});

	test("validateAndApply: throws on empty old", () => {
		expect(() => validateAndApply("content", "", "new", false)).toThrow('"old" parameter content must not be empty.');
	});

	test("validateAndApply: throws on not found", () => {
		expect(() => validateAndApply("content", "NOPE", "new", false)).toThrow(
			'"old" parameter content not found in file. Ensure it matches the file exactly.',
		);
	});

	test("validateAndApply: throws on multiple without replaceAll", () => {
		expect(() => validateAndApply("aXbXc", "X", "Y", false)).toThrow("matches 2 locations");
	});

	test("validateAndApply: replaceAll works", () => {
		const result = validateAndApply("aXbXc", "X", "Y", true);
		expect(result.result).toBe("aYbYc");
		expect(result.replaceCount).toBe(2);
	});
});
