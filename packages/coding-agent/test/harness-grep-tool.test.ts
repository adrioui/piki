import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGrepAgentTool, defineGrepHarnessTool } from "../src/core/harness/tools/grep.ts";

describe("grep harness tool", () => {
	let tempDir: string;
	let scratchpadDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "piki-grep-test-"));
		scratchpadDir = mkdtempSync(join(tmpdir(), "piki-grep-scratch-"));
		mkdirSync(join(tempDir, "src"));
		writeFileSync(join(tempDir, "src", "a.ts"), "alpha\nbeta\nalphabet", "utf-8");
		writeFileSync(join(tempDir, "src", "b.md"), "alpha markdown", "utf-8");
		writeFileSync(join(scratchpadDir, "note.txt"), "scratch alpha", "utf-8");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(scratchpadDir, { recursive: true, force: true });
	});

	test("searches text files with regex, path, glob, and limit", async () => {
		const tool = defineGrepHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ pattern: "alpha", path: "src", glob: "*.ts", limit: 1 }));

		expect(result).toEqual([{ file: "a.ts", match: "alpha" }]);
	});

	test("expands scratchpad paths", async () => {
		const tool = defineGrepHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ pattern: "alpha", path: "$M" }));

		expect(result).toEqual([{ file: "note.txt", match: "scratch alpha" }]);
	});

	test("adapter returns search matches as details", async () => {
		const agentTool = createGrepAgentTool(defineGrepHarnessTool(tempDir, scratchpadDir));
		const result = await agentTool.execute("call-1", { pattern: "beta", path: "src" });

		expect(result.details).toEqual([{ file: "a.ts", match: "beta" }]);
		expect(result.content[0]?.type).toBe("text");
	});
});
