/**
 * Sci Wave-2 permission/approval/safeguard-flag parity probe.
 *
 * Scoped to dimensions NOT yet covered by permission-gate.test.ts /
 * sci-wave2-shellgit.test.ts:
 *   - exact rejection reason strings vs mag alpha22 observables
 *   - structural default-allow/deny divergence (mag allowAll-last vs piki
 *     known-tools/interactive default-allow + unknown default-deny)
 *   - getRolePolicyRules ~/.piki mass-rm rule wiring
 *   - piki "ask"/"delegate" approval superset (mag has only Proceed/Deny)
 *
 * References: magnitude-alpha22.embedded.js
 *   - denyForbiddenCommands (80760), denyMutatingGit (80782),
 *     denyWritesOutside (80794), denyMassDestructiveIn (80820),
 *     evaluatePolicy (80847, ends deny("No matching policy rule") only if
 *     no rule returned non-null), allowAll (80844, always proceeds).
 *   - reason literals: 80804 / 80813 / 80791 / 80839; isForbidden
 *     (80564) ":"/mkfs/dd/git reason strings; denyMutatingGit reason
 *     "Only read-only git commands are allowed" (80791).
 */

import { describe, expect, it } from "vitest";
import { evaluatePermission } from "../../../src/core/permissions/permission-gate.ts";
import { getRolePolicyRules } from "../../../src/core/permissions/role-policy.ts";

const CWD = "/home/user/project";
const SCRATCH = "/home/user/.piki";
const _HOME = "/home/user";

type Opts = Parameters<typeof evaluatePermission>[2];

function leaderOpts(extra: Opts = {}): Opts {
	return { roleId: "leader", cwd: CWD, scratchpadPath: SCRATCH, ...extra };
}

describe("mag reason-string parity (observable divergence audit)", () => {
	it("write outside allowed dirs: reason matches mag 'Cannot write files outside allowed directories'", () => {
		const r = evaluatePermission("write", { path: "/etc/passwd" }, leaderOpts());
		expect(r.permitted).toBe(false);
		expect(r.reason).toBe("Cannot write files outside allowed directories");
	});

	it("shell write outside allowed dirs: reason matches mag 'Command targets paths outside allowed directories'", () => {
		const r = evaluatePermission("bash", { command: "tee /etc/passwd" }, leaderOpts());
		expect(r.permitted).toBe(false);
		expect(r.reason).toBe("Command targets paths outside allowed directories");
	});

	it("mass-destructive within [cwd,scratchpad] is allowed (mag phase-1 parity)", () => {
		// mag denyMassDestructiveIn phase 1: allowed when writesStayWithin
		// [cwd, scratchpadPath]. piki mirrors (nonProtectedRoots=[cwd,scratchpad]).
		const r = evaluatePermission("bash", { command: "rm -rf ./build" }, leaderOpts());
		expect(r.permitted).toBe(true);
	});

	it("mass-destructive escaping ALL roots denied by cwd-boundary (mag-parity ordering)", () => {
		// piki evaluates the cwd write-boundary (disableCwdSafeguards-gated)
		// and rejects escapes with "Command targets paths outside allowed
		// directories" — same observable string as mag's denyWritesOutside.
		const r = evaluatePermission("bash", { command: "rm -rf /opt/other/x" }, leaderOpts());
		expect(r.permitted).toBe(false);
		expect(r.reason).toBe("Command targets paths outside allowed directories");
	});

	it("DIVERGENCE: mutating git reason differs from mag", () => {
		// mag denyMutatingGit reason: "Only read-only git commands are allowed"
		// (80791). piki emits the same generic string for non-forbidden-tier git
		// mutations (e.g. `git commit -m x`), but forbidden-tier subcommands
		// (reset/clean/restore/checkout) get a more specific reason. Both DENY.
		const r = evaluatePermission("bash", { command: "git commit -m x" }, leaderOpts());
		expect(r.permitted).toBe(false);
		expect(r.reason).toBe("Only read-only git commands are allowed");
	});

	it("DIVERGENCE: ':' sentinel reason shorter than mag", () => {
		// mag isForbidden(":"): "This command is blocked as a shell-control
		// sentinel, not a useful task action. Use a read-only check like `pwd`
		// or `ls` instead." piki omits the `Use a read-only...` suffix.
		const r = evaluatePermission("bash", { command: ":" }, leaderOpts());
		expect(r.permitted).toBe(false);
		expect(r.reason).toBe("This command is blocked as a shell-control sentinel, not a useful task action.");
	});

	it("DIVERGENCE: mkfs/parted reason wording differs from mag", () => {
		// mag mkfs: "Formatting filesystems can irreversibly erase disk data. Use
		// read-only disk inspection like `lsblk` or `diskutil list` instead."
		// piki forbidReasonForSysadminAlways("mkfs"/"parted"): "Partition edits
		// can irreversibly alter disks and destroy data".
		const r = evaluatePermission("bash", { command: "mkfs /dev/sdx" }, leaderOpts());
		expect(r.permitted).toBe(false);
		expect(r.reason).toBe("High-impact system administration command is blocked");
	});

	it("MATCH: dd raw-device reason identical to mag", () => {
		const r = evaluatePermission("bash", { command: "dd of=/dev/sda" }, leaderOpts());
		expect(r.permitted).toBe(false);
		expect(r.reason).toBe(
			"Raw device copy/write can destroy entire disks quickly. Use file-level copy commands on workspace files only.",
		);
	});
});

describe("structural default-allow/deny divergence vs mag", () => {
	it("DIVERGENCE: mag default-allows unknown tools; piki default-denies (non-interactive)", () => {
		// mag policy chain ends with allowAll() -> unknown tool proceeds unless one
		// of the 4 deny rules fires. piki has no allowAll; non-interactive unknown
		// tool with no knownTools -> denied by default.
		const r = evaluatePermission("totally_unknown_tool", { foo: "bar" }, { interactive: false });
		expect(r.permitted).toBe(false);
		expect(r.reason).toContain("default is deny");
	});

	it("piki known-tools default-allow (mag has no equivalent concept)", () => {
		const r = evaluatePermission(
			"custom_registered_tool",
			{},
			{ interactive: false, knownTools: ["custom_registered_tool"] },
		);
		expect(r.permitted).toBe(true);
		expect(r.reason).toContain("registered with the runtime");
	});

	it("mag-equivalent: a tool that evades the 4 deny rules is allowed in mag but denied in piki headless", () => {
		// e.g. a benign unknown read-style tool. mag allowAll permits it; piki
		// default-denies in non-interactive, allows in interactive.
		const headless = evaluatePermission("new_read_tool", { path: "x" }, { interactive: false });
		const interactive = evaluatePermission("new_read_tool", { path: "x" }, { interactive: true });
		expect(headless.permitted).toBe(false);
		expect(interactive.permitted).toBe(true);
	});
});

describe("getRolePolicyRules ~/.piki mass-rm wiring", () => {
	it("includes a reject rule for mass-rm targeting ~/.piki", () => {
		const rules = getRolePolicyRules("leader", CWD, SCRATCH, {});
		const hit = rules.find(
			(r) => r.tool === "/^(bash|shell)$/" && r.action === "reject" && (r.message ?? "").includes(".piki"),
		);
		expect(hit).toBeDefined();
	});

	it("omits the ~/.piki rm rule when disableShellSafeguards is set", () => {
		const rules = getRolePolicyRules("leader", CWD, SCRATCH, { disableShellSafeguards: true });
		const hit = rules.find((r) => (r.message ?? "").includes(".piki"));
		expect(hit).toBeUndefined();
	});

	it("roleId/cwd/scratchpad params are accepted (signature parity); same rules regardless of roleId", () => {
		const leader = getRolePolicyRules("leader", CWD, SCRATCH, {});
		const worker = getRolePolicyRules("engineer", CWD, SCRATCH, {});
		expect(leader.length).toBe(worker.length);
	});
});

describe("piki approval superset: ask / delegate", () => {
	it("ask action surfaces as permitted:false with action 'ask' (mag has no ask — Proceed/Deny only)", () => {
		const r = evaluatePermission(
			"risky",
			{},
			{ interactive: false, userRules: [{ tool: "risky", action: "ask", message: "Confirm?" }] },
		);
		expect(r.permitted).toBe(false);
		expect(r.action).toBe("ask");
	});

	it("delegate action surfaces as permitted:false with action 'delegate' (mag has no delegate)", () => {
		const r = evaluatePermission(
			"legacy",
			{},
			{ interactive: false, userRules: [{ tool: "legacy", action: "delegate", to: "ext" }] },
		);
		expect(r.permitted).toBe(false);
		expect(r.action).toBe("delegate");
		expect(r.reason).toContain("not supported");
	});
});
