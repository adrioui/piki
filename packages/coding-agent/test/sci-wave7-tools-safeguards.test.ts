import { describe, expect, it } from "vitest";

import { evaluatePermission } from "../src/core/permissions/permission-gate.ts";
import { classifyShellCommand, isGitMutation } from "../src/core/permissions/shell-classifier.ts";

const CWD = "/home/user/project";
const SCRATCH = "/home/user/.piki";

const leader = {
	roleId: "leader" as const,
	scratchpadPath: SCRATCH,
	cwd: CWD,
	interactive: true,
};

function shell(command: string) {
	return evaluatePermission("bash", { command }, leader);
}

describe("Sci W7: rm home vs system target classification", () => {
	it("rm -rf / is forbidden (mag hasForce+targetsSystem -> forbidden, not mass-destructive)", () => {
		expect(classifyShellCommand("rm -rf /").level).toBe("forbidden");
	});
	it("rm -rf /etc forbidden", () => {
		expect(classifyShellCommand("rm -rf /etc").level).toBe("forbidden");
	});
	// mag: rm -rf ~ has force but ~ not a SYSTEM_DIR -> not forbidden in isForbidden;
	// falls to isMassDestructive -> tier mass-destructive. mag denyMassDestructiveIn:
	// nonProtected=[cwd,scratch]| ~ outside both and outside protected ~/.magnitude -> denied by cwd boundary.
	it("rm -rf ~/x classified (record piki tier)", () => {
		const t = classifyShellCommand("rm -rf ~/x").level;
		// piki treats recursive root/home as forbidden; record the divergence.
		expect(["forbidden", "mass-destructive"]).toContain(t);
	});
	it("rm -r ./build mass-destructive (no force needed, mag hasRecursiveRmFlag on -r)", () => {
		expect(classifyShellCommand("rm -r ./build").level).toBe("mass-destructive");
	});
	it("rm ./build (no r) is NOT mass-destructive (mag requires recursive flag)", () => {
		expect(classifyShellCommand("rm ./build").level).not.toBe("mass-destructive");
	});
});

describe("Sci W7: mass-destructive phase-1 roots", () => {
	it("rm -rf in cwd ALLOWED", () => {
		expect(shell("rm -rf ./build").permitted).toBe(true);
	});
	it("rm -rf in scratchpad ALLOWED (phase1 non-protected roots include scratchpad)", () => {
		// mag: nonProtectedRoots = [cwd, scratchpadPath]; ~/.piki IS the scratchpad here.
		expect(shell("rm -rf /home/user/.piki/x").permitted).toBe(true);
	});
	it("rm -rf escaping ALL roots DENIED (falls to cwd boundary)", () => {
		const r = shell("rm -rf /home/user/elsewhere");
		expect(r.permitted).toBe(false);
		expect(r.reason).toContain("outside allowed directories");
	});
	it("rm -rf /tmp/x ALLOWED (mag /tmp outside-prefix exemption honored in writesStayWithin)", () => {
		expect(shell("rm -rf /tmp/x").permitted).toBe(true);
	});
});

describe("Sci W7: git -C global option handling", () => {
	it("git -C /tmp status is read-only (mag findSubcommand skips -C value)", () => {
		expect(isGitMutation("git -C /tmp status")).toBe(false);
	});
	it("git -C/tmp status read-only", () => {
		expect(isGitMutation("git -C/tmp status")).toBe(false);
	});
	it("git --git-dir=/x status read-only (attached value form)", () => {
		expect(isGitMutation("git --git-dir=/x status")).toBe(false);
	});
});

describe("Sci W7: git branch rename/copy/delete forbidden", () => {
	it("git branch -m old new is mutating", () => {
		expect(isGitMutation("git branch -m old new")).toBe(true);
	});
	it("git branch -c a b is mutating", () => {
		expect(isGitMutation("git branch -c a b")).toBe(true);
	});
	it("git branch -d feat is mutating", () => {
		expect(isGitMutation("git branch -d feat")).toBe(true);
	});
	it("git branch -a read-only", () => {
		expect(isGitMutation("git branch -a")).toBe(false);
	});
	it("git branch --show-current read-only", () => {
		expect(isGitMutation("git branch --show-current")).toBe(false);
	});
});

describe("Sci W7: interpreter -c wrapping parity", () => {
	it("bash -c 'rm -rf /etc' forbidden (mag nested classifyShellCommand)", () => {
		expect(classifyShellCommand("bash -c 'rm -rf /etc'").level).toBe("forbidden");
	});
	it("sh -c 'rm -rf /' forbidden", () => {
		expect(classifyShellCommand("sh -c 'rm -rf /'").level).toBe("forbidden");
	});
});

describe("Sci W7: independent safeguard flags", () => {
	it("disableShellSafeguards lifts forbidden git (mag denyMutatingGit gated by it)", () => {
		expect(shell("git commit -m x").permitted).toBe(false);
		const r = evaluatePermission("bash", { command: "git commit -m x" }, { ...leader, disableShellSafeguards: true });
		expect(r.permitted).toBe(true);
	});
	it("disableCwdSafeguards lifts write boundary but keeps forbidden classification", () => {
		const r = evaluatePermission("write", { path: "/etc/passwd" }, { ...leader, disableCwdSafeguards: true });
		expect(r.permitted).toBe(true);
	});
	it("disableCwdSafeguards does NOT lift mass-destructive forbidden git", () => {
		const r = evaluatePermission("bash", { command: "git commit -m x" }, { ...leader, disableCwdSafeguards: true });
		expect(r.permitted).toBe(false);
	});
});

describe("Sci W7: $M/ scratchpad expansion in write boundary", () => {
	it("write $M/reports/x.md ALLOWED (expandScratchpadPath resolves inside scratchpad)", () => {
		const r = evaluatePermission("write", { path: "$M/reports/x.md" }, leader);
		expect(r.permitted).toBe(true);
	});
	it("write $M/../escape.md ALLOWED (mag-parity: expandScratchpadPath returns notExpanded, lexical resolve stays inside cwd)", () => {
		const r = evaluatePermission("write", { path: "$M/../escape.md" }, leader);
		expect(r.permitted).toBe(true);
	});
});

describe("Sci W7: mag read-only git allowlist strictness", () => {
	// mag isGitReadOnly only allows status/log/diff/show/rev-parse(+readonly branch).
	// Everything else (ls-files, blame, grep, tag -l, config --get, remote -v) is a mutation.
	it("git ls-files is mutating (blocked)", () => {
		expect(isGitMutation("git ls-files")).toBe(true);
	});
	it("git blame is mutating (blocked) — mag default=false", () => {
		expect(isGitMutation("git blame file.ts")).toBe(true);
	});
	it("git config --get is mutating (blocked) — mag default=false", () => {
		expect(isGitMutation("git config --get user.name")).toBe(true);
	});
	it("git remote -v is mutating (blocked) — mag default=false", () => {
		expect(isGitMutation("git remote -v")).toBe(true);
	});
});
