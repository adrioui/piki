/**
 * S7 — Tool observable output-shape probes (piki vs mag alpha22).
 *
 * These tests invoke the actual piki tool `execute` functions directly (no
 * provider) and assert what the MODEL observes after a tool runs — the output
 * string and result `details`. They pin down the divergences the parity audit
 * flagged (read line-range/continuation, grep text format, bash exit-code
 * surfacing, edit field superset) so future changes are caught.
 *
 * Reference: mag `magnitude-alpha22.embedded.js` tool schemas/outputs.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "s7-tool-"));
});
afterAll(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* noop */
	}
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

describe("S7 — read observable output", () => {
	it("returns a line-range and a continuation notice for partial reads", async () => {
		const f = join(dir, "r.txt");
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
		writeFileSync(f, `${lines.join("\n")}\n`);
		const tool = createReadToolDefinition(dir);
		const res = await tool.execute(
			"tc",
			{ path: f, offset: 1, limit: 10 } as never,
			undefined,
			undefined,
			{} as never,
		);
		const text = textOf(res);
		// mag returns "<slice>\n... (N more lines remaining. Use offset=... to continue reading.)"
		// piki returns "Showing lines A-B of C. Use offset=N to continue."
		expect(text).toContain("line 1");
		// The direct tool definition does not include the wrapper's preparation;
		// assert the continuation protocol rather than a total-line banner.
		expect(text).toContain("line 10");
		expect(text.toLowerCase()).toContain("offset=");
	});

	it("matches mag param names (path/offset/limit) and default whole-file when no limit", async () => {
		const f = join(dir, "r2.txt");
		writeFileSync(f, "a\nb\nc\n");
		const tool = createReadToolDefinition(dir);
		const res = await tool.execute("tc", { path: f } as never, undefined, undefined, {} as never);
		const text = textOf(res);
		expect(text).toContain("a");
		expect(text).toContain("c");
		// No continuation notice for a small complete file.
		expect(text).not.toContain("offset=");
	});
});

describe("S7 — read line cap (fixed 2000 = mag parity, D1)", () => {
	it("caps at exactly 2000 lines and emits mag's continuation notice", async () => {
		const f = join(dir, "big-default.txt");
		writeFileSync(f, `${Array.from({ length: 5000 }, (_, i) => `row ${i + 1}`).join("\n")}\n`);
		const tool = createReadToolDefinition(dir);
		const res = await tool.execute("tc", { path: f } as never, undefined, undefined, {} as never);
		const text = textOf(res);
		const shown = text.split("\n").filter((l) => l.startsWith("row ")).length;
		// mag's `read` uses a fixed `maxLines = limit ?? 2000`; piki now matches exactly.
		expect(shown).toBe(2000);
		expect(text).toContain("... (3000 more lines remaining. Use offset=2001 to continue reading.)");
	});

	it("does not scale above 2000 for large context windows (mag parity removed the proportional superset)", async () => {
		const f = join(dir, "big-large.txt");
		writeFileSync(f, `${Array.from({ length: 9000 }, (_, i) => `row ${i + 1}`).join("\n")}\n`);
		const tool = createReadToolDefinition(dir);
		const res = await tool.execute("tc", { path: f } as never, undefined, undefined, {
			model: { contextWindow: 2_000_000, input: ["text" as never] },
		} as never);
		const text = textOf(res);
		const shown = text.split("\n").filter((l) => l.startsWith("row ")).length;
		// mag's fixed 2000 cap applies regardless of context window.
		expect(shown).toBe(2000);
		expect(text).toContain("... (7000 more lines remaining. Use offset=2001 to continue reading.)");
	});
});

describe("S7 — grep observable output is TEXT (divergence from mag structured)", () => {
	it("emits `path:line: text` text, not a structured Array<{file, match}>", async () => {
		const f = join(dir, "g.txt");
		writeFileSync(f, `${["alpha one", "beta two", "alpha three"].join("\n")}\n`);
		const tool = createGrepToolDefinition(dir);
		const res = await tool.execute("tc", { pattern: "alpha", path: dir } as never, undefined, undefined, {} as never);
		const text = textOf(res);
		// piki shape: "<relative>:<linenum>: <text>"
		expect(text).toContain(":1: alpha one");
		expect(text).toContain(":3: alpha three");
		// mag shape would be JSON `{ "file": "...", "match": "1|alpha one" }`.
		// Assert piki does NOT produce mag's pipe-delimited `match` field.
		expect(text).not.toMatch(/"match"\s*:\s*"\d+\|/);
	});

	it("respects default limit of 50 and emits a match-limit notice", async () => {
		const f = join(dir, "g2.txt");
		writeFileSync(f, `${Array.from({ length: 60 }, (_, i) => `hit ${i + 1}`).join("\n")}\n`);
		const tool = createGrepToolDefinition(dir);
		const res = await tool.execute("tc", { pattern: "hit", path: dir } as never, undefined, undefined, {} as never);
		const text = textOf(res);
		expect(text).toContain("matches limit");
		expect(text).toContain("limit=100");
	});
});

describe("S7 — bash non-zero exit surfaced as completed result (mag parity)", () => {
	it("returns exit code in details without appending status text, for non-zero exit", async () => {
		const tool = createBashToolDefinition(dir);
		const res = await tool.execute("tc", { command: "exit 3" } as never, undefined, undefined, {} as never);
		const text = textOf(res);
		expect(text).not.toContain("Command exited with code 3");
		// mag shell returns mode:"completed" with exitCode and no appended text —
		// piki carries exitCode in details rather than throwing.
		expect((res.details as { exitCode?: number } | undefined)?.exitCode).toBe(3);
	});
});

describe("S7 — edit schema is a SUPERSET of mag (adds edits[])", () => {
	it("accepts top-level old/new (alpha22 flat form) and folds into edits[]", async () => {
		const f = join(dir, "e.txt");
		writeFileSync(f, "hello world\n");
		const tool = createEditToolDefinition(dir);
		const prepared = tool.prepareArguments
			? tool.prepareArguments({ path: f, old: "hello", new: "hi" })
			: ({ path: f, old: "hello", new: "hi" } as never);
		const res = await tool.execute("tc", prepared as never, undefined, undefined, {} as never);
		const text = textOf(res);
		expect(text).toContain("Replaced 1 line(s) with 1 line(s)");
		const after = readFileSync(f, "utf-8");
		expect(after).toBe("hi world\n");
	});
});

describe("S7 — write returns Void (mag parity, D1/G-write-empty)", () => {
	it("emits empty model-visible content matching mag's Void outputSchema", async () => {
		const f = join(dir, "w.txt");
		const tool = createWriteToolDefinition(dir);
		const res = await tool.execute("tc", { path: f, content: "abc" } as never, undefined, undefined, {} as never);
		const text = textOf(res);
		// mag's write tool outputSchema is Void: the model-visible content is empty.
		expect(text).toBe("");
		expect(res.details).toBeUndefined();
	});
});
