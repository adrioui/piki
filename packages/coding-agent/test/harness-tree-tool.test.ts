import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTreeAgentTool, defineTreeHarnessTool } from "../src/core/harness/tools/tree.ts";

describe("tree harness tool", () => {
	let tempDir: string;
	let scratchpadDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "piki-tree-test-"));
		scratchpadDir = mkdtempSync(join(tmpdir(), "piki-tree-scratch-"));
		mkdirSync(join(tempDir, "src", "nested"), { recursive: true });
		writeFileSync(join(tempDir, ".gitignore"), "ignored.txt\n", "utf-8");
		writeFileSync(join(tempDir, "src", "nested", "a.ts"), "alpha", "utf-8");
		writeFileSync(join(tempDir, "ignored.txt"), "ignored", "utf-8");
		writeFileSync(join(scratchpadDir, "note.md"), "scratch", "utf-8");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(scratchpadDir, { recursive: true, force: true });
	});

	test("lists directory entries recursively while respecting gitignore", async () => {
		const tool = defineTreeHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: ".", recursive: true, gitignore: true }));

		expect(result).toContainEqual({ path: "src", name: "src", type: "dir", depth: 0 });
		expect(result).toContainEqual({ path: "src/nested/a.ts", name: "a.ts", type: "file", depth: 2 });
		expect(result.some((entry) => entry.path === "ignored.txt")).toBe(false);
	});

	test("honors maxDepth", async () => {
		const tool = defineTreeHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: ".", recursive: true, maxDepth: 0 }));

		expect(result.some((entry) => entry.path === "src/nested/a.ts")).toBe(false);
	});

	test("expands scratchpad paths", async () => {
		const tool = defineTreeHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "$M" }));

		expect(result).toContainEqual({ path: "note.md", name: "note.md", type: "file", depth: 0 });
	});

	test("adapter returns tree entries as details", async () => {
		const agentTool = createTreeAgentTool(defineTreeHarnessTool(tempDir, scratchpadDir));
		const result = await agentTool.execute("call-1", { path: "." });

		expect(result.details.length).toBeGreaterThan(0);
		expect(result.content[0]?.type).toBe("text");
	});
});
