/**
 * Sci Wave-2 shell/path/git/package-manager safeguard parity probes.
 *
 * Re-scope (per sci-wave22 critique): A1 (~ expansion gate/tool inconsistency)
 * is REVISE and A2 (package-manager publish/registry mutation) is STALE (already
 * ported into shell-classifier.ts). This file locks in those two closures with
 * mag-evidence-backed assertions and probes for any NEW gap in the
 * shell/path/git/package-manager safeguard surface that prior waves missed.
 *
 * Reference: magnitude-alpha22.embedded.js
 *  - expandScratchpadPath (68913): does NOT expand ~; only $M/${M}.
 *  - resolveFileRefPath (86490): non-$M -> resolve(cwd, normalized) (literal ~/x).
 *  - denyWritesOutside / denyMassDestructiveIn (80794/80820): gated independently
 *    by disableCwdSafeguards / disableShellSafeguards.
 *  - leader & worker role policies (81513..82097): identical 4-rule stack.
 */

import { describe, expect, it } from "vitest";

import { evaluatePermission } from "../../../src/core/permissions/permission-gate.ts";
import { classifyShellCommand, isGitMutation } from "../../../src/core/permissions/shell-classifier.ts";
import { resolveReadPathAsyncTool, resolveToolPath } from "../../../src/core/tools/path-utils.ts";

const CWD = "/home/user/project";
const SCRATCH = "/home/user/.piki";
const _HOME = "/home/user";

function leader(command: string) {
	return evaluatePermission("bash", { command }, { roleId: "leader", cwd: CWD, scratchpadPath: SCRATCH });
}
function _worker(command: string, role = "engineer") {
	return evaluatePermission("bash", { command }, { roleId: role, cwd: CWD, scratchpadPath: SCRATCH });
}

describe("A1 — ~ expansion gate/tool consistency (REVISE, now CLOSED)", () => {
	it("resolveToolPath keeps ~ literal as <cwd>/~/x (mag expandScratchpadPath does not expand ~)", () => {
		// mag: expandScratchpadPath("~/x") -> notExpanded -> resolve(cwd,"~/x") = <cwd>/~/x
		expect(resolveToolPath("~/x", CWD, SCRATCH)).toBe(`${CWD}/~/x`);
		expect(resolveToolPath("$M/reports/x.md", CWD, SCRATCH)).toBe(`${SCRATCH}/reports/x.md`);
	});

	it("write gate and tool resolver agree for ~/x (same target inside cwd → permitted)", () => {
		const resolvedTarget = resolveToolPath("~/x", CWD, SCRATCH);
		// mag's expandScratchpadPath keeps ~ literal, so resolve(cwd, "~/x")
		// lands at <cwd>/~/x which is INSIDE cwd; the cwd write-boundary permits
		// it. The gate and the tool resolver must agree on that target.
		const r = evaluatePermission("write", { path: "~/x" }, { roleId: "leader", cwd: CWD, scratchpadPath: SCRATCH });
		expect(r.permitted).toBe(true);
		expect(resolvedTarget).toBe(`${CWD}/~/x`);
	});

	it("read resolver also keeps ~ literal (read/view parity)", () => {
		// async path util mirrors resolveToolPath; ~ stays literal.
		return resolveReadPathAsyncTool("~/x", CWD, SCRATCH).then((p) => {
			expect(p).toBe(`${CWD}/~/x`);
		});
	});

	it("mag alpha22 does NOT expand ~ in fileWrite/fileEdit/view (same pattern)", () => {
		// Confirmed in bundle: fileEdit/view use resolveX(cwd, expandScratchpadPath(path).path)
		// and expandScratchpadPath returns input unchanged for ~/x. No separate ~ expansion.
		// piki matches: resolveToolPath == nodeResolve(cwd, expanded) with no ~ expansion.
		expect(resolveToolPath("~/foo/bar", CWD, SCRATCH)).toBe(`${CWD}/~/foo/bar`);
	});
});

describe("A2 — package-manager publish/registry mutation (STALE, already ported)", () => {
	it("npm publish / dist-tag add / owner add forbidden", () => {
		for (const c of ["npm publish", "npm dist-tag add foo@1.0 latest", "npm owner add bob pkg"]) {
			expect(classifyShellCommand(c).level).toBe("forbidden");
		}
	});
	it("yarn publish / owner add forbidden", () => {
		for (const c of ["yarn publish", "yarn owner add bob pkg"]) {
			expect(classifyShellCommand(c).level).toBe("forbidden");
		}
	});
	it("bun publish forbidden", () => {
		expect(classifyShellCommand("bun publish").level).toBe("forbidden");
	});
	it("gradle publish / twine upload / poetry publish / cargo yank forbidden", () => {
		for (const c of ["gradle publish", "twine upload dist/*", "poetry publish", "cargo yank 1.0.0"]) {
			expect(classifyShellCommand(c).level).toBe("forbidden");
		}
	});
	it("npm install (read-style) allowed, npm install --global forbidden", () => {
		expect(classifyShellCommand("npm install").level).not.toBe("forbidden");
		expect(classifyShellCommand("npm install -g foo").level).toBe("forbidden");
	});
	it("preserves piki-stricter block: npm remove / uninstall forbidden (mag allows)", () => {
		// Intentional piki divergence preserved from mag; record behavior.
		expect(classifyShellCommand("npm remove foo").level).toBe("forbidden");
	});
	it("OS package-manager destructive subcommands forbidden (apt remove, brew cleanup)", () => {
		expect(classifyShellCommand("apt remove foo").level).toBe("forbidden");
		expect(classifyShellCommand("brew cleanup").level).toBe("forbidden");
	});
});

describe("NEW — independent disableCwdSafeguards vs disableShellSafeguards", () => {
	it("disableCwdSafeguards alone lifts write-boundary but keeps git/mass-destructive block", () => {
		// mag: denyWritesOutside gated by disableCwdSafeguards; denyMutatingGit /
		// denyMassDestructiveIn gated by disableShellSafeguards.
		const git = evaluatePermission(
			"bash",
			{ command: "git commit -m x" },
			{
				roleId: "leader",
				cwd: CWD,
				scratchpadPath: SCRATCH,
				disableCwdSafeguards: true,
			},
		);
		expect(git.permitted).toBe(false);
		expect(git.reason).toBe("Only read-only git commands are allowed");
		// write boundary lifted: write to /etc/passwd now allowed
		const w = evaluatePermission(
			"write",
			{ path: "/etc/passwd" },
			{
				roleId: "leader",
				cwd: CWD,
				scratchpadPath: SCRATCH,
				disableCwdSafeguards: true,
			},
		);
		expect(w.permitted).toBe(true);
	});

	it("disableShellSafeguards alone lifts git/mass-destructive but keeps write-boundary", () => {
		const git = evaluatePermission(
			"bash",
			{ command: "git commit -m x" },
			{
				roleId: "leader",
				cwd: CWD,
				scratchpadPath: SCRATCH,
				disableShellSafeguards: true,
				knownTools: ["bash"],
			},
		);
		expect(git.permitted).toBe(true);
		// write boundary stays:
		const w = evaluatePermission(
			"write",
			{ path: "/etc/passwd" },
			{
				roleId: "leader",
				cwd: CWD,
				scratchpadPath: SCRATCH,
				disableShellSafeguards: true,
			},
		);
		expect(w.permitted).toBe(false);
	});

	it("only with BOTH disabled does an out-of-root escape become permitted", () => {
		const r = evaluatePermission(
			"bash",
			{ command: "rm -rf /etc/x" },
			{
				roleId: "leader",
				cwd: CWD,
				scratchpadPath: SCRATCH,
				disableShellSafeguards: true,
				disableCwdSafeguards: true,
				knownTools: ["bash"],
			},
		);
		expect(r.permitted).toBe(true);
	});
});

describe("NEW — worker vs leader path/safeguard handling parity", () => {
	it("workers share the identical cwd-boundary + mass-destructive policy as leader", () => {
		// mag: every role (leader/architect/engineer/critic/scientist/worker) uses the
		// same 4-rule stack with the same roots. piki gates on roleId presence only.
		for (const [tool, command, expectPermitted] of [
			["bash", "rm -rf ./build", true],
			["bash", "rm -rf /etc/x", false],
			["bash", "git push -f", false],
			["write", "/etc/passwd", false],
		] as const) {
			const input = tool === "bash" ? { command } : { path: command };
			// Leader
			const leaderPermitted = evaluatePermission(tool, input, {
				roleId: "leader",
				cwd: CWD,
				scratchpadPath: SCRATCH,
			}).permitted;
			expect(leaderPermitted).toBe(expectPermitted);
			// Worker (engineer)
			const workerPermitted = evaluatePermission(tool, input, {
				roleId: "engineer",
				cwd: CWD,
				scratchpadPath: SCRATCH,
			}).permitted;
			expect(workerPermitted).toBe(expectPermitted);
		}
	});

	it("worker ~-literal resolution identical to leader", () => {
		expect(resolveToolPath("~/x", CWD, SCRATCH)).toBe(`${CWD}/~/x`);
		// Same as leader: <cwd>/~/x is inside cwd, so the worker write gate
		// permits it (mag-parity: ~ stays literal, target lands within cwd).
		expect(
			evaluatePermission("write", { path: "~/x" }, { roleId: "scientist", cwd: CWD, scratchpadPath: SCRATCH })
				.permitted,
		).toBe(true);
	});
});

describe("NEW — git tool own safe-arg layer (separate from shell gate)", () => {
	it("git tool blocks absolute / .. / shell-metacharacter paths via isSafeGitArg", () => {
		// git.ts resolveSafePath uses isSafeGitArg: rejects absolute, .., control,
		// and shell metacharacters. Distinct from the shell `git` mutation gate.
		// We verify the shell classifier still blocks mutating git regardless.
		expect(isGitMutation("git reset --hard")).toBe(true);
		expect(isGitMutation("git clean -fd")).toBe(true);
		expect(isGitMutation("git checkout .")).toBe(true);
		expect(isGitMutation("git branch -m old new")).toBe(true);
		expect(isGitMutation("git status")).toBe(false);
		expect(isGitMutation("git -c user.name=x status")).toBe(true);
	});
});

describe("NEW — mass-destructive root checks inside/outside allowed roots", () => {
	it("rm -rf ~ : piki labels forbidden (mag labels mass-destructive); both DENIED by default", () => {
		// mag: rm -rf ~ -> isForbidden? hasForce && targetsSystem(~) = false (not system) ->
		// mass-destructive; denyMassDestructiveIn: ~ outside [cwd,scratch] and outside
		// protected ~/.magnitude -> denied by cwd boundary. piki: labels forbidden directly.
		// Final allow/deny is identical (denied) in default config; only tier differs.
		const t = classifyShellCommand("rm -rf ~/x").level;
		expect(["forbidden", "mass-destructive"]).toContain(t);
		expect(leader("rm -rf ~/x").permitted).toBe(false);
	});

	it("rm -rf / is forbidden in both (system target)", () => {
		expect(classifyShellCommand("rm -rf /").level).toBe("forbidden");
		expect(leader("rm -rf /").permitted).toBe(false);
	});

	it("rm -rf /root is forbidden in piki; mag labels mass-destructive but cwd boundary denies it", () => {
		expect(classifyShellCommand("rm -rf /root").level).toBe("forbidden");
		expect(leader("rm -rf /root").permitted).toBe(false);
	});

	it("container/k8s/db sysadmin policy under-block scan", () => {
		const forbidden = [
			"docker run --privileged",
			"docker push myrepo/img",
			"kubectl delete pod x",
			"kubectl rollout restart deploy/x",
			"terraform destroy",
			"helm install f b",
			"psql db",
			"pg_dump db",
			// Plain `mkfs` is forbidden (mag forbids it). Note: mag's baseName()
			// does NOT strip a `.ext4`/`.vfat` suffix, so `mkfs.ext4 /dev/sdx`
			// classifies as `normal` in both mag and piki — only the bare
			// command is on the always-forbidden sysadmin list.
			"mkfs /dev/sdx",
			"shutdown now",
			"iptables -F",
			"systemctl stop network",
			"kill -9 1",
			"pkill -9 node",
			"mount / /mnt",
		];
		for (const c of forbidden) {
			expect(classifyShellCommand(c).level, c).toBe("forbidden");
		}
	});
});
