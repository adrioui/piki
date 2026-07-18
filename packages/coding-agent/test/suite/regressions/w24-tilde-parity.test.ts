import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluatePermission } from "../../../src/core/permissions/permission-gate.ts";
import { resolveToolPath } from "../../../src/core/tools/path-utils.ts";
import { createReadTool } from "../../../src/core/tools/read.ts";
import type { WriteToolInput } from "../../../src/core/tools/write.ts";
import { createWriteTool } from "../../../src/core/tools/write.ts";

// W24 GAP-1 parity regression: piki file-tool `~` handling must match Magnitude
// alpha22. mag PERMITS `write ~/x` and resolves it to `<cwd>/~/x` (a literal `~`
// subdir inside cwd); piki previously REJECTED `~/x` (gate raw-path check) and
// wrote `~/x` to `$HOME/x`. This test locks the corrected behavior.

const CWD = "/proj/root";
const SCRATCH = "/proj/root/.piki-scratch";

const leaderOpts = {
	roleId: "leader" as const,
	scratchpadPath: SCRATCH,
	cwd: CWD,
	interactive: true,
};

describe("W24 GAP-1: file-tool ~ handling matches mag", () => {
	it("gate permits write ~/note.txt (was rejected before the fix)", () => {
		const r = evaluatePermission("write", { path: "~/note.txt" }, leaderOpts);
		expect(r.permitted).toBe(true);
	});

	it("gate still rejects ../escape.txt outside cwd", () => {
		const r = evaluatePermission("write", { path: "../escape.txt" }, leaderOpts);
		expect(r.permitted).toBe(false);
	});

	it("gate permits $M/x.txt", () => {
		const r = evaluatePermission("write", { path: "$M/x.txt" }, leaderOpts);
		expect(r.permitted).toBe(true);
	});

	it("gate permits write $M/../escape.md (mag-parity lexical resolve stays inside cwd)", () => {
		const r = evaluatePermission("write", { path: "$M/../escape.md" }, leaderOpts);
		expect(r.permitted).toBe(true);
	});

	it("gate permits edit /tmp/x (mag /tmp outside-prefix exemption)", () => {
		const r = evaluatePermission("edit", { path: "/tmp/x", old: "a", new: "b" }, leaderOpts);
		expect(r.permitted).toBe(true);
	});

	it("resolveToolPath resolves ~/note.txt to <cwd>/~/note.txt", () => {
		expect(resolveToolPath("~/note.txt", CWD, SCRATCH)).toBe(`${CWD}/~/note.txt`);
	});

	it("resolveToolPath expands $M/reports/x.md to <scratch>/reports/x.md", () => {
		expect(resolveToolPath("$M/reports/x.md", CWD, SCRATCH)).toBe(`${SCRATCH}/reports/x.md`);
	});
});

describe("W24 GAP-1: write tool lands at <cwd>/~/note.txt, not $HOME/note.txt", () => {
	let tempCwd: string;
	const scratchpadPath = join(tmpdir(), `w24-scratch-${Date.now()}-${Math.random().toString(36).slice(2)}`);

	beforeEach(() => {
		tempCwd = mkdtempSync(join(tmpdir(), "w24-cwd-"));
	});

	afterEach(() => {
		rmSync(tempCwd, { recursive: true, force: true });
	});

	it("writing ~/note.txt creates <cwd>/~/note.txt and not $HOME/note.txt", async () => {
		const writeDef = createWriteTool(tempCwd, { scratchpadPath });
		const readDef = createReadTool(tempCwd, { scratchpadPath });

		// Sanity: gate permits the write under a leader-like context.
		const gate = evaluatePermission(
			"write",
			{ path: "~/note.txt" },
			{
				roleId: "leader",
				cwd: tempCwd,
				scratchpadPath,
				interactive: true,
			},
		);
		expect(gate.permitted).toBe(true);

		const writeResult = await writeDef.execute("call-1", {
			path: "~/note.txt",
			content: "hello tilde",
		} as WriteToolInput);
		expect(writeResult.terminate).toBeFalsy();

		const expected = join(tempCwd, "~", "note.txt");
		expect(existsSync(expected)).toBe(true);
		expect(existsSync(join(process.env.HOME ?? "", "note.txt"))).toBe(false);

		// Read it back via the read tool (async mag-parity resolver).
		const readResult = await readDef.execute("call-2", { path: "~/note.txt" });
		const text = readResult.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("");
		expect(text).toContain("hello tilde");
	});
});
