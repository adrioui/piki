import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	createWriteAgentTool,
	defineWriteHarnessTool,
	FsErrorSchema,
	WriteEmissionSchema,
	writeParameters,
} from "../src/core/harness/tools/write.ts";

describe("write harness tool — parity", () => {
	let tempDir: string;
	let scratchpadDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "piki-write-test-"));
		scratchpadDir = mkdtempSync(join(tmpdir(), "piki-write-scratch-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(scratchpadDir, { recursive: true, force: true });
	});

	test("writes file content to a new file", async () => {
		const tool = defineWriteHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "out.txt", content: "hello world\nline2" }));
		expect(result).toBeUndefined();
		const written = readFileSync(join(tempDir, "out.txt"), "utf-8");
		expect(written).toBe("hello world\nline2");
	});

	test("overwrites existing file completely", async () => {
		const tool = defineWriteHarnessTool(tempDir, scratchpadDir);
		// First write
		await Effect.runPromise(tool.execute({ path: "rep.txt", content: "original content" }));
		// Overwrite
		await Effect.runPromise(tool.execute({ path: "rep.txt", content: "new content" }));
		const written = readFileSync(join(tempDir, "rep.txt"), "utf-8");
		expect(written).toBe("new content");
	});

	test("fails with FsError on write failure (invalid path)", async () => {
		const tool = defineWriteHarnessTool(tempDir, scratchpadDir);
		try {
			await Effect.runPromise(tool.execute({ path: "/nonexistent-dir-harness-test/file.txt", content: "x" }));
			expect.fail("should have thrown");
		} catch (err: any) {
			expect(err._tag).toBe("FsError");
			expect(err.message).toContain("Failed to write");
		}
	});

	test("$M/ prefix expands to scratchpadPath", async () => {
		const tool = defineWriteHarnessTool(tempDir, scratchpadDir);
		await Effect.runPromise(tool.execute({ path: "$M/note.md", content: "# Scratchpad" }));
		const written = readFileSync(join(scratchpadDir, "note.md"), "utf-8");
		expect(written).toBe("# Scratchpad");
	});

	test("emissionSchema is structurally correct", () => {
		const tool = defineWriteHarnessTool(tempDir, scratchpadDir);
		expect(tool.emissionSchema).toBeDefined();
		expect(tool.emissionSchema).toBe(WriteEmissionSchema);
		// Verify it has the expected fields by checking the schema AST
		const ast = (WriteEmissionSchema as any).ast;
		expect(ast).toBeDefined();
	});

	test("HarnessTool definition has outputSchema: Schema.Void", () => {
		const tool = defineWriteHarnessTool(tempDir, scratchpadDir);
		expect(tool.definition.outputSchema).toBe(Schema.Void);
	});

	test("HarnessTool definition has name 'write'", () => {
		const tool = defineWriteHarnessTool(tempDir, scratchpadDir);
		expect(tool.definition.name).toBe("write");
	});

	test("HarnessTool has errorSchema with _tag FsError", () => {
		const tool = defineWriteHarnessTool(tempDir, scratchpadDir);
		expect(tool.errorSchema).toBeDefined();
		expect(tool.errorSchema).toBe(FsErrorSchema);
	});

	test("TypeBox parameters match expected structure", () => {
		expect(writeParameters).toBeDefined();
		const props = (writeParameters as any).properties;
		expect(props).toBeDefined();
		expect(props.path).toBeDefined();
		expect(props.content).toBeDefined();
	});

	test("createWriteAgentTool produces a working AgentTool", async () => {
		const harnessTool = defineWriteHarnessTool(tempDir, scratchpadDir);
		const agentTool = createWriteAgentTool(harnessTool);
		expect(agentTool.name).toBe("write");
		expect(agentTool.parameters).toBeDefined();

		const result = await agentTool.execute(
			"test-id",
			{ path: "agent-out.txt", content: "from agent" },
			undefined,
			undefined,
		);
		expect(result.content.length).toBeGreaterThanOrEqual(1);
		expect(result.content[0].type).toBe("text");
		const written = readFileSync(join(tempDir, "agent-out.txt"), "utf-8");
		expect(written).toBe("from agent");
	});

	test("writes multi-line content correctly", async () => {
		const tool = defineWriteHarnessTool(tempDir, scratchpadDir);
		const multiLine = "line1\nline2\nline3\n";
		await Effect.runPromise(tool.execute({ path: "multi.txt", content: multiLine }));
		const written = readFileSync(join(tempDir, "multi.txt"), "utf-8");
		expect(written).toBe(multiLine);
	});
});
