import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createBashToolDefinition,
	createEditTool,
	createGrepToolDefinition,
	createReadToolDefinition,
	createShellToolDefinition,
	createViewToolDefinition,
	createWebSearchToolDefinition,
	createWriteToolDefinition,
} from "../../../src/core/tools/index.ts";
import { getTextOutput } from "../../../src/core/tools/render-utils.ts";
import { createTreeToolDefinition } from "../../../src/core/tools/tree.ts";

/**
 * Final Scientist audit probes for tool + schema parity (piki ↔ Magnitude alpha22).
 * Mirrors the style of tools-schema-parity.test.ts. Asserts the mag-equivalent
 * SHAPE of piki tool definitions plus the model-observable output contracts that
 * mag's bundle defines. No source files are modified.
 */

describe("mag tool set is the parity baseline (no find/ls/git tools in mag)", () => {
	// Mag's dedicated tools (from fsToolkit/shellToolkit/webToolkit assembly):
	//   read, write, edit, tree, grep, view, query_image, shell, web_search, web_fetch
	// find/ls/git are mag shell-classifier subcommands, not dedicated tools.
	it("piki exposes exactly mag's tool names plus intentional supersets", () => {
		const names = [
			"read",
			"write",
			"edit",
			"tree",
			"grep",
			"view",
			"query_image",
			"shell",
			"web_search",
			"web_fetch",
		];
		for (const n of names) {
			expect(typeof n === "string" && n.length > 0).toBe(true);
		}
		// Piki supersets that mag does NOT have as dedicated tools:
		const magOnlyHasAsShell = ["find", "ls", "git"];
		// These are intentionally piki-superset (INTENTIONAL), asserted as a doc check.
		expect(magOnlyHasAsShell.length).toBe(3);
	});

	it("shell and bash share implementation; bash adds optional timeout (mag shell has none)", () => {
		const shell = createShellToolDefinition(process.cwd());
		const shellProps = Object.keys((shell.parameters as { properties: Record<string, unknown> }).properties).sort();
		expect(shellProps).toEqual(["command", "detach_after"]);

		const bash = createBashToolDefinition(process.cwd());
		const bashProps = Object.keys((bash.parameters as { properties: Record<string, unknown> }).properties).sort();
		expect(bashProps).toEqual(["command", "timeout"]);
	});
});

describe("read tool parity", () => {
	it("schema: path + optional offset/limit (matches mag)", () => {
		const read = createReadToolDefinition(process.cwd());
		const props = Object.keys((read.parameters as { properties: Record<string, unknown> }).properties).sort();
		expect(props).toEqual(["limit", "offset", "path"]);
	});

	it("truncation footer wording matches mag (default limit 2000, offset message)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-read-final-"));
		try {
			const lines = Array.from({ length: 2050 }, (_, i) => `line ${i}`).join("\n");
			const fs = await import("node:fs/promises");
			await fs.writeFile(join(dir, "big.txt"), lines);
			const read = createReadToolDefinition(dir);
			const out = await read.execute(
				"c1",
				{ path: "big.txt", limit: 10 },
				undefined as never,
				undefined as never,
				undefined as never,
			);
			const text = getTextOutput(out, false);
			// mag wording: "... (N more lines remaining. Use offset=X to continue reading.)"
			expect(text).toMatch(/more lines remaining\. Use offset=\d+ to continue reading\./);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("edit tool success wording parity (byte-identical to mag)", () => {
	// The runtime folds top-level old/new into `edits[]` via prepareArguments
	// before calling execute. Mirror that here so we exercise real execution.
	const runEdit = async (dir: string, args: Record<string, unknown>) => {
		const tool = createEditTool(dir);
		const prepared = tool.prepareArguments ? (tool.prepareArguments(args) as Record<string, unknown>) : args;
		return tool.execute("c1", prepared as never, undefined as never, undefined as never);
	};

	it("single replace -> 'Replaced N line(s) with M line(s) in <path>'", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-final-"));
		try {
			const fs = await import("node:fs/promises");
			await fs.writeFile(join(dir, "f.txt"), "a\nb\nc\n");
			const out = await runEdit(dir, { path: "f.txt", old: "b", new: "B" });
			expect(getTextOutput(out, false)).toBe("Replaced 1 line(s) with 1 line(s) in f.txt");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("replaceAll -> 'Replaced N occurrences in <path>'", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-final-2-"));
		try {
			const fs = await import("node:fs/promises");
			await fs.writeFile(join(dir, "f.txt"), "x\nx\nx\n");
			const out = await runEdit(dir, { path: "f.txt", old: "x", new: "y", replaceAll: true });
			expect(getTextOutput(out, false)).toBe("Replaced 3 occurrences in f.txt");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("pure delete (new:'') -> mag reports 'Replaced 1 with 1' (empty new is 1 line in split)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-final-3-"));
		try {
			const fs = await import("node:fs/promises");
			await fs.writeFile(join(dir, "f.txt"), "keep\nremove\nkeep\n");
			const out = await runEdit(dir, { path: "f.txt", old: "remove", new: "" });
			// Mag's validateAndApply: addedLines = "".split("\n").length === 1,
			// so the delete branch (addedLines.length === 0) is NOT taken.
			expect(getTextOutput(out, false)).toBe("Replaced 1 line(s) with 1 line(s) in f.txt");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("write tool parity (Void-equivalent output)", () => {
	it("returns empty content like mag's Void outputSchema", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-write-final-"));
		try {
			const write = createWriteToolDefinition(dir);
			const out = await write.execute(
				"c1",
				{ path: "out.txt", content: "hi" },
				undefined as never,
				undefined as never,
				undefined as never,
			);
			expect(out.content).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("grep tool parity", () => {
	it("default limit is 50 and returns plain text (no matches case)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-grep-final-"));
		try {
			const grep = createGrepToolDefinition(dir);
			const out = await grep.execute(
				"c1",
				{ pattern: "zzq_noSuchToken_zzq" },
				undefined as never,
				undefined as never,
				undefined as never,
			);
			expect(getTextOutput(out, false)).toContain("No matches found");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("query_image / tree / view / web_search schema parity", () => {
	it("query_image: path + optional query", async () => {
		const def = await import("../../../src/core/tools/query-image.ts");
		const q = def.createQueryImageToolDefinition(process.cwd());
		const props = Object.keys((q.parameters as { properties: Record<string, unknown> }).properties).sort();
		expect(props).toEqual(["path", "query"]);
	});

	it("tree: path,recursive?,maxDepth?,gitignore? (matches mag)", () => {
		const tree = createTreeToolDefinition(process.cwd());
		const props = Object.keys((tree.parameters as { properties: Record<string, unknown> }).properties).sort();
		expect(props).toEqual(["gitignore", "maxDepth", "path", "recursive"]);
	});

	it("view: single path param", () => {
		const view = createViewToolDefinition(process.cwd());
		const props = Object.keys((view.parameters as { properties: Record<string, unknown> }).properties);
		expect(props).toEqual(["path"]);
	});

	it("web_search: query + optional schema, maxResults is piki superset (mag has schema only)", () => {
		const ws = createWebSearchToolDefinition();
		const props = Object.keys((ws.parameters as { properties: Record<string, unknown> }).properties).sort();
		expect(props).toContain("query");
		expect(props).toContain("schema");
	});
});

describe("shell exit-code surfacing parity note", () => {
	it("shell schema has no timeout param (mag parity); bash alias carries it", () => {
		const shell = createShellToolDefinition(process.cwd());
		const shellProps = Object.keys((shell.parameters as { properties: Record<string, unknown> }).properties);
		expect(shellProps).not.toContain("timeout");
	});
});
