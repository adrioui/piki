/**
 * Scientist wave-final parity probes for permissions & approval behavior
 * piki vs Magnitude alpha22. Faux-only, deterministic. No source changes.
 *
 * Covers the dimensions called out in the audit:
 *   Q1/Q2  leader write/edit/edit-diff cwd-boundary + independent
 *          --disable-cwd-safeguards vs --disable-shell-safeguards
 *   Q3     git mutation classification (-c/-cX/--config-env, branch rename,
 *          --output/--exec/--ext-diff/--textconv/--paginate)
 *   Q4     mass-destructive in-root allow / escape deny (denyMassDestructiveIn)
 *   Q5     package-manager mutation policy (isLangPackageManagerForbidden)
 *   Q6     container/k8s/iac/db/sysadmin policy
 *   Q7     approval/denial reason strings (exact mag text where divergent)
 *   Q8     default behavior for unknown tools
 */

import { describe, expect, it } from "vitest";
import { evaluatePermission } from "../../src/core/permissions/permission-gate.ts";
import { classifyShellCommand, isGitMutation } from "../../src/core/permissions/shell-classifier.ts";

const CWD = "/home/user/project";
const SP = "/home/user/.piki-scratch";

/** Leader gate options mirroring mag createLeaderRole policy assembly. */
function leaderOpts(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		roleId: "leader",
		rolePolicyRules: [],
		cwd: CWD,
		scratchpadPath: SP,
		disableShellSafeguards: false,
		disableCwdSafeguards: false,
		...over,
	};
}

describe("Q1/Q2 — leader cwd-boundary + flag independence", () => {
	it("blocks write/edit/edit-diff outside [cwd, scratchpad, ~/.piki]", () => {
		for (const tool of ["write", "edit", "edit-diff"]) {
			const d = evaluatePermission(tool, { path: "/etc/x" }, leaderOpts());
			expect(d.permitted, `${tool} /etc/x`).toBe(false);
		}
	});

	it("emits mag-exact denial reason for cwd write boundary", () => {
		const d = evaluatePermission("write", { path: "/etc/x" }, leaderOpts());
		expect(d.reason).toBe("Cannot write files outside allowed directories");
	});

	it("--disable-cwd-safeguards lifts ONLY the cwd write boundary", () => {
		const d = evaluatePermission("write", { path: "/etc/x" }, leaderOpts({ disableCwdSafeguards: true }));
		expect(d.permitted, "write boundary lifted").toBe(true);
		// shell safeguards still active: git mutation still blocked
		const g = evaluatePermission("bash", { command: "git push" }, leaderOpts({ disableCwdSafeguards: true }));
		expect(g.permitted, "shell safeguards intact").toBe(false);
	});

	it("--disable-shell-safeguards lifts git/mass-destructive but NOT cwd boundary", () => {
		const g = evaluatePermission("bash", { command: "git push" }, leaderOpts({ disableShellSafeguards: true }));
		expect(g.permitted, "git mutation now allowed").toBe(true);
		const w = evaluatePermission("write", { path: "/etc/x" }, leaderOpts({ disableShellSafeguards: true }));
		expect(w.permitted, "cwd write boundary intact").toBe(false);
	});

	it("allows write inside cwd", () => {
		const d = evaluatePermission("write", { path: `${CWD}/src/x.ts` }, leaderOpts());
		expect(d.permitted).toBe(true);
	});
});

describe("Q3 — git mutation classification parity", () => {
	it("blocks config overrides on otherwise-readonly subcommands", () => {
		expect(isGitMutation("git -c user.name=x status")).toBe(true);
		expect(isGitMutation("git --config-env=FOO=bar status")).toBe(true);
		expect(isGitMutation("git -cuser.name=x status")).toBe(true);
	});

	it("blocks branch rename/copy (-m/-M/-c/-C)", () => {
		expect(isGitMutation("git branch -m old new")).toBe(true);
		expect(isGitMutation("git branch -M old")).toBe(true);
		expect(isGitMutation("git branch -c old new")).toBe(true);
	});

	it("blocks unsafe output/exec flags on any subcommand", () => {
		for (const flag of ["--output=f", "--exec=x", "--ext-diff", "--textconv", "--paginate"]) {
			expect(isGitMutation(`git diff ${flag}`), flag).toBe(true);
		}
	});

	it("still allows read-only git", () => {
		for (const c of [
			"git status",
			"git log",
			"git diff",
			"git show HEAD",
			"git rev-parse HEAD",
			"git branch",
			"git branch -a",
		]) {
			expect(isGitMutation(c), c).toBe(false);
		}
	});

	// Q7: git mutation denial reason matches mag's denyMutatingGit exactly.
	// mag returns "Only read-only git commands are allowed"; piki mirrors it
	// byte-for-byte (permission-gate.ts git-mutation branch).
	it("Q7 — git denial reason matches mag text", () => {
		const d = evaluatePermission("bash", { command: "git push" }, leaderOpts());
		expect(d.permitted).toBe(false);
		expect(d.reason).toBe("Only read-only git commands are allowed");
	});
});

describe("Q4 — mass-destructive in-root allow / escape deny", () => {
	it("allows mass-destructive staying within cwd", () => {
		const d = evaluatePermission("bash", { command: "rm -rf ./build" }, leaderOpts());
		expect(d.permitted).toBe(true);
	});

	it("denies mass-destructive escaping into system dirs", () => {
		const d = evaluatePermission("bash", { command: "rm -rf /etc/build" }, leaderOpts());
		expect(d.permitted).toBe(false);
	});

	it("allows mass-destructive in /tmp (alpha22 outside-prefix exemption)", () => {
		const d = evaluatePermission("bash", { command: "rm -rf /tmp/x" }, leaderOpts());
		expect(d.permitted).toBe(true);
	});

	it("denies mass-destructive within protected ~/.piki root", () => {
		const d = evaluatePermission("bash", { command: "rm -rf ~/.piki/x" }, leaderOpts());
		expect(d.permitted).toBe(false);
		expect(d.reason).toBe("Mass-destructive operations are not allowed in protected directories");
	});
});

describe("Q5 — package-manager mutation policy", () => {
	const blocked = [
		"npm publish",
		"poetry publish",
		"npm rebuild",
		"yarn remove pkg",
		"pnpm unpublish",
		"cargo login",
		"gem push",
	];
	const allowed = ["npm install", "npm run build", "yarn add pkg", "pip install pkg", "bun run build"];
	it("blocks publish/rebuild/remove/uninstall/login", () => {
		for (const command of blocked) {
			const d = evaluatePermission("bash", { command }, leaderOpts());
			expect(d.permitted, `expected "${command}" blocked`).toBe(false);
		}
	});
	it("allows install/add/build", () => {
		for (const command of allowed) {
			const d = evaluatePermission("bash", { command }, leaderOpts());
			expect(d.permitted, `expected "${command}" allowed`).toBe(true);
		}
	});
});

describe("Q6 — container/k8s/iac/db/sysadmin policy", () => {
	it("blocks container privileged / remote push / prune", () => {
		expect(classifyShellCommand("docker push my/img").level).toBe("forbidden");
		expect(classifyShellCommand("podman run --privileged nginx").level).toBe("forbidden");
		expect(classifyShellCommand("nerdctl system prune").level).toBe("forbidden");
	});

	it("blocks kubectl/helm/terraform/pulumi mutations", () => {
		expect(classifyShellCommand("kubectl delete pod x").level).toBe("forbidden");
		expect(classifyShellCommand("helm install foo bar").level).toBe("forbidden");
		expect(classifyShellCommand("terraform apply").level).toBe("forbidden");
		expect(classifyShellCommand("pulumi up").level).toBe("forbidden");
	});

	it("blocks db shells + db utilities (piki superset of mag)", () => {
		for (const command of ["psql -c 'SELECT 1'", "mysql db", "mongo", "pg_dump db", "createdb nd", "dropdb od"]) {
			expect(classifyShellCommand(command).level, command).toBe("forbidden");
		}
	});

	it("blocks power/partition/firewall always-forbidden (piki superset)", () => {
		for (const command of [
			"shutdown now",
			"reboot",
			"fdisk /dev/sda",
			"iptables -F",
			"ufw disable",
			"firewall-cmd --reload",
		]) {
			expect(classifyShellCommand(command).level, command).toBe("forbidden");
		}
	});

	it("blocks chroot/user/group admin (piki superset beyond mag)", () => {
		for (const command of ["chroot /mnt /bin/sh", "useradd bob", "usermod -aG sudo bob", "groupadd devs"]) {
			expect(classifyShellCommand(command).level, command).toBe("forbidden");
		}
	});
});

describe("Q8 — default behavior for unknown tools", () => {
	it("piki default-DENIES unknown tools in non-interactive (stricter than mag allowAll)", () => {
		const d = evaluatePermission("frobnicate", {}, leaderOpts({ knownTools: ["read", "write"], interactive: false }));
		expect(d.permitted).toBe(false);
	});

	it("piki allows unknown tools in interactive (warns, does not block)", () => {
		const d = evaluatePermission("frobnicate", {}, leaderOpts({ knownTools: ["read", "write"], interactive: true }));
		expect(d.permitted).toBe(true);
	});

	it("known/registered tools allowed by default", () => {
		const d = evaluatePermission(
			"write",
			{ path: `${CWD}/x` },
			leaderOpts({ knownTools: ["write"], interactive: false }),
		);
		expect(d.permitted).toBe(true);
	});
});
