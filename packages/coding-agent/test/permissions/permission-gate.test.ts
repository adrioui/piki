/**
 * Tests for the shell/cwd safeguard gating in evaluatePermission.
 */

import { describe, expect, it } from "vitest";
import { evaluatePermission } from "../../src/core/permissions/permission-gate.ts";

describe("evaluatePermission shell safeguards", () => {
	it("rejects forbidden/mass-destructive shell by default", () => {
		const forbidden = evaluatePermission("bash", { command: "rm -rf /tmp/x" }, { cwd: "/home/user/project" });
		expect(forbidden.permitted).toBe(true);
		// With no cwd context, ~ escapes the protected root and is permitted
		// (mag: no denyWritesOutside boundary active, phase 2 misses ~/.piki).
		const mass = evaluatePermission("bash", { command: "rm -rf ~/" }, {});
		expect(mass.permitted).toBe(true);
		const escaped = evaluatePermission("bash", { command: "rm -rf /etc/x" }, { cwd: "/home/user/project" });
		expect(escaped.permitted).toBe(false);
	});

	it("allows forbidden/mass-destructive shell when disableShellSafeguards is set", () => {
		const forbidden = evaluatePermission(
			"bash",
			{ command: "rm -rf /tmp/x" },
			{ disableShellSafeguards: true, knownTools: ["bash"] },
		);
		expect(forbidden.permitted).toBe(true);
		const mass = evaluatePermission(
			"bash",
			{ command: "rm -rf ~/" },
			{ disableShellSafeguards: true, knownTools: ["bash"] },
		);
		expect(mass.permitted).toBe(true);
	});

	it("rejects destructive git/rm by default (chmod/chown are boundary-checked, not forbidden)", () => {
		// NOTE (W14 parity): mag does not forbid chmod/chown; they are
		// boundary-checked via WRITE_PATH_COMMANDS. piki matches that, so
		// `chmod -R 777 /tmp/x` is permitted (mag shares the /tmp/ allowed-outside
		// prefix). Out-of-root chmod/chown are rejected by the cwd boundary — see
		// the boundary tests below, not this destructive-shell test.
		const cases = [
			"git reset --hard",
			"git clean -fd",
			"git commit --no-verify",
			"git push -f",
			"git stash",
			"git add -A",
			"git add ./",
			"rm -rf /",
			"rm -rf ~",
		];
		for (const command of cases) {
			const decision = evaluatePermission("bash", { command }, { cwd: "/home/user/project" });
			expect(decision.permitted, `expected "${command}" to be blocked`).toBe(false);
		}
	});

	it("boundary-checks chmod/chown: in-root allowed, out-of-root rejected (W14 parity)", () => {
		const cwd = "/home/user/project";
		// In-root: allowed (boundary-checked like mag WRITE_PATH_COMMANDS).
		expect(evaluatePermission("bash", { command: "chmod 644 ./x" }, { cwd }).permitted).toBe(true);
		expect(evaluatePermission("bash", { command: "chown user ./x" }, { cwd }).permitted).toBe(true);
		// Out-of-root (not /tmp): rejected by the cwd boundary.
		expect(evaluatePermission("bash", { command: "chmod 644 /etc/passwd" }, { cwd }).permitted).toBe(false);
		// mag shares the /tmp/ allowed-outside prefix, so this is permitted.
		expect(evaluatePermission("bash", { command: "chmod -R 777 /tmp/x" }, { cwd }).permitted).toBe(true);
	});

	it("allows destructive git/rm when disableShellSafeguards is set (chmod also boundary-allowed)", () => {
		const cases = [
			"git reset --hard",
			"git clean -fd",
			"git commit --no-verify",
			"git push -f",
			"git stash",
			"git add -A",
			"git add ./",
			"rm -rf /",
			"rm -rf ~",
			"chmod -R 777 /tmp/x",
		];
		for (const command of cases) {
			const decision = evaluatePermission(
				"bash",
				{ command },
				{
					disableShellSafeguards: true,
					knownTools: ["bash"],
				},
			);
			expect(decision.permitted).toBe(true);
		}
	});

	it("blocks a broad set of mutating git subcommands (alpha22 parity: all non-read-only git)", () => {
		const denials = [
			"git commit -m 'msg'",
			"git push origin main",
			"git checkout -b feature",
			"git checkout main",
			"git merge main",
			"git rebase main",
			"git branch new-feature",
			"git branch -D old-feature",
			"git reset HEAD~1",
			"git restore src/",
			"git rm file.txt",
			"git tag v1.0",
			"git remote add upstream <url>",
			"git fetch --all",
			"git pull origin main",
		];
		for (const command of denials) {
			const decision = evaluatePermission("bash", { command }, {});
			expect(decision.permitted, `expected "${command}" to be blocked`).toBe(false);
			expect(decision.reason).toContain("git");
		}
	});

	it("allows read-only git subcommands", () => {
		const alloweds = [
			"git status",
			"git log --oneline",
			"git diff HEAD",
			"git show HEAD",
			"git rev-parse HEAD",
			"git branch",
			"git branch -l",
			"git branch -a",
		];
		for (const command of alloweds) {
			const decision = evaluatePermission("bash", { command }, {});
			expect(decision.permitted, `expected "${command}" to be allowed`).toBe(true);
		}
	});

	it("still allows normal bash and read tools when safeguards disabled", () => {
		const normalBash = evaluatePermission(
			"bash",
			{ command: "ls -la" },
			{
				disableShellSafeguards: true,
				knownTools: ["bash"],
			},
		);
		expect(normalBash.permitted).toBe(true);
		const read = evaluatePermission(
			"read",
			{ path: "/tmp/x" },
			{
				disableShellSafeguards: true,
				knownTools: ["read"],
			},
		);
		expect(read.permitted).toBe(true);
	});
});

describe("evaluatePermission shell cwd-boundary (alpha22 denyWritesOutside parity)", () => {
	const cwd = "/home/user/project";
	const scratch = "/home/user/.piki/scratch";

	it("rejects shell redirect outside allowed roots", () => {
		const decision = evaluatePermission(
			"bash",
			{ command: "echo x > /etc/passwd" },
			{ cwd, scratchpadPath: scratch },
		);
		expect(decision.permitted).toBe(false);
		expect(decision.reason).toContain("outside allowed directories");
	});

	it("allows shell redirect within cwd", () => {
		const decision = evaluatePermission("bash", { command: "echo x > out.txt" }, { cwd, scratchpadPath: scratch });
		expect(decision.permitted).toBe(true);
	});

	it("allows /tmp writes (allowed-outside prefix)", () => {
		const decision = evaluatePermission(
			"bash",
			{ command: "echo x > /tmp/out.txt" },
			{ cwd, scratchpadPath: scratch },
		);
		expect(decision.permitted).toBe(true);
	});

	it("rejects write-path command arg outside roots", () => {
		const decision = evaluatePermission("bash", { command: "cp a /usr/bin/a" }, { cwd, scratchpadPath: scratch });
		expect(decision.permitted).toBe(false);
	});

	it("allows write-path command arg within cwd", () => {
		const decision = evaluatePermission("bash", { command: "mv a ./b" }, { cwd, scratchpadPath: scratch });
		expect(decision.permitted).toBe(true);
	});

	it("rejects after cd to a directory outside roots", () => {
		const decision = evaluatePermission(
			"bash",
			{ command: "cd /etc && echo x > y" },
			{ cwd, scratchpadPath: scratch },
		);
		expect(decision.permitted).toBe(false);
	});

	it("allows after cd into a subdir of cwd", () => {
		const decision = evaluatePermission("bash", { command: "cd src && touch y" }, { cwd, scratchpadPath: scratch });
		expect(decision.permitted).toBe(true);
	});

	it("allows read of absolute system paths (read-only commands not gated)", () => {
		const decision = evaluatePermission("bash", { command: "cat /etc/hosts" }, { cwd, scratchpadPath: scratch });
		expect(decision.permitted).toBe(true);
	});

	it("leader: cwd-only roots (no scratchpadPath) still gates writes outside cwd", () => {
		const decision = evaluatePermission("bash", { command: "echo x > /etc/passwd" }, { cwd });
		expect(decision.permitted).toBe(false);
		const allowed = evaluatePermission("bash", { command: "echo x > ./out.txt" }, { cwd });
		expect(allowed.permitted).toBe(true);
	});

	it("worker: + ~/.piki root; scratchpad write allowed", () => {
		const decision = evaluatePermission("bash", { command: "echo x > $M/y" }, { cwd, scratchpadPath: scratch });
		expect(decision.permitted).toBe(true);
	});

	it("disableCwdSafeguards bypasses the boundary check (independent of disableShellSafeguards)", () => {
		const decision = evaluatePermission(
			"bash",
			{ command: "echo x > /etc/passwd" },
			{ cwd, scratchpadPath: scratch, disableCwdSafeguards: true, knownTools: ["bash"] },
		);
		expect(decision.permitted).toBe(true);
	});

	it("disableShellSafeguards alone does NOT bypass the cwd boundary (T2 independent flags)", () => {
		const decision = evaluatePermission(
			"bash",
			{ command: "echo x > /etc/passwd" },
			{ cwd, scratchpadPath: scratch, disableShellSafeguards: true, knownTools: ["bash"] },
		);
		expect(decision.permitted).toBe(false);
	});

	it("no cwd/scratchpadPath options -> boundary check skipped (legacy behavior)", () => {
		const decision = evaluatePermission("bash", { command: "echo x > /etc/passwd" }, { knownTools: ["bash"] });
		expect(decision.permitted).toBe(true);
	});
});
