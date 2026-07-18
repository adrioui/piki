import { describe, expect, it } from "vitest";
import { evaluatePermission } from "../../../src/core/permissions/permission-gate.ts";
import { resolveToolPath } from "../../../src/core/tools/path-utils.ts";

// Wave-16 path/safeguard parity probe (W24 GAP-1 fix).
// Mag keeps `~` literal in file-tool paths: expandScratchpadPath does NOT
// tilde-expand, so `~/foo` resolves to `<cwd>/~/foo` (a literal subdir in cwd).
// piki now matches this: the gate permits `~/x` and the tools resolve it to
// `<cwd>/~/x` via resolveToolPath. This probe asserts the parity.

const CWD = "/proj/root";
const SCRATCH = "/proj/root/.piki-scratch";

const leaderOpts = {
	roleId: "leader" as const,
	scratchpadPath: SCRATCH,
	cwd: CWD,
	interactive: true,
};

describe("s16/W24 tilde expansion in file-tool path resolution (mag parity)", () => {
	it("gate permits write ~/foo.txt (resolves to <cwd>/~/foo.txt)", () => {
		const r = evaluatePermission("write", { path: "~/foo.txt" }, leaderOpts);
		expect(r.permitted).toBe(true);
	});

	it("resolveToolPath keeps ~ literal under cwd", () => {
		expect(resolveToolPath("~/foo.txt", CWD, SCRATCH)).toBe(`${CWD}/~/foo.txt`);
	});

	it("$M expansion matches mag", () => {
		expect(resolveToolPath("$M/reports/x.md", CWD, SCRATCH)).toBe(`${SCRATCH}/reports/x.md`);
	});

	it("write $M/reports/x.md permitted", () => {
		const r = evaluatePermission("write", { path: "$M/reports/x.md" }, leaderOpts);
		expect(r.permitted).toBe(true);
	});

	it("write $M/../escape.md permitted (mag-parity lexical resolve stays inside cwd)", () => {
		const r = evaluatePermission("write", { path: "$M/../escape.md" }, leaderOpts);
		expect(r.permitted).toBe(true);
	});

	it("escape outside cwd still rejected", () => {
		const r = evaluatePermission("write", { path: "../escape.txt" }, leaderOpts);
		expect(r.permitted).toBe(false);
	});

	it("edit /tmp/x permitted (mag /tmp outside-prefix exemption)", () => {
		const r = evaluatePermission("edit", { path: "/tmp/x", old: "a", new: "b" }, leaderOpts);
		expect(r.permitted).toBe(true);
	});
});
