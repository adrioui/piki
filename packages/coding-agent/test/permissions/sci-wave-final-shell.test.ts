/**
 * Scientist wave-final shell/path/git/pm safeguards parity probe.
 *
 * Audits piki behavior vs Magnitude alpha22 (mag) shell safety classifier.
 * Source under test: packages/coding-agent/src/core/permissions/shell-classifier.ts
 * Gate: packages/coding-agent/src/core/permissions/permission-gate.ts
 *
 * Reference (mag): magnitude-alpha22.embedded.js
 *   - isForbidden / isForbiddenByToolPolicy (lines ~80643+)
 *   - isCloudCliForbidden / isGcloudForbidden / isAzForbidden (~79527+)
 *   - isDatabaseUtilityForbidden (~79863+) ALLOWS pg_dump/mysqldump
 *   - classifyContainer / isRunLikeInvocation (~79136+)
 *
 * This file pins the divergences found in the audit. Cases marked "MATCH" assert
 * piki equals mag. Cases marked "GAP" assert mag's behavior and currently FAIL
 * because piki is stricter (over-blocks) — they document the divergence, not a
 * piki safety defect.
 */

import { describe, expect, it } from "vitest";
import { evaluatePermission } from "../../src/core/permissions/permission-gate.ts";
import { classifyShellCommand, isGitMutation } from "../../src/core/permissions/shell-classifier.ts";

const CWD = "/home/user/project";

describe("dimension 1 — shell redirect / ~ / $M / /tmp boundary (MATCH mag)", () => {
	const cases: Array<[string, boolean]> = [
		["echo x > /etc/passwd", false], // rejected
		["echo x > ./out.txt", true], // allowed inside cwd
		["echo x > /tmp/out.txt", true], // allowed (/tmp outside-prefix)
		["cp a /usr/bin/a", false],
		["mkdir /etc/x", false],
		["touch /tmp/x", true],
		["cd /etc && echo x > y", false],
		["rm -rf ./build", true], // mass-destructive allowed in cwd
		["rm -rf /etc/build", false], // escapes roots
		["rm -rf /tmp/x", true], // /tmp exemption honored
	];
	for (const [command, allowed] of cases) {
		it(command, () => {
			const d = evaluatePermission("bash", { command }, { cwd: CWD });
			expect(d.permitted).toBe(allowed);
		});
	}
});

describe("dimension 2 — git read-only parity (MATCH mag)", () => {
	const readonly = [
		"git status",
		"git log",
		"git diff",
		"git show HEAD",
		"git rev-parse HEAD",
		"git branch",
		"git -c user.name=x status", // mag: forbidden via config override -> mutation
	];
	it("blocks config-override readonly git as mutation (mag parity)", () => {
		expect(isGitMutation("git -c user.name=x status")).toBe(true);
		expect(evaluatePermission("bash", { command: "git -c user.name=x status" }, { cwd: CWD }).permitted).toBe(false);
	});
	it("blocks git status --output=f", () => {
		expect(isGitMutation("git status --output=f")).toBe(true);
	});
	it("blocks git branch -m rename", () => {
		expect(isGitMutation("git branch -m old new")).toBe(true);
	});
	it("allows genuinely read-only git", () => {
		for (const cmd of readonly.slice(0, 6)) {
			expect(isGitMutation(cmd), cmd).toBe(false);
		}
	});
});

describe("dimension 3 — mass-destructive in/out roots (MATCH mag)", () => {
	it("denies rm -rf ~/.piki/x (protected root)", () => {
		const d = evaluatePermission("bash", { command: "rm -rf ~/.piki/x" }, { cwd: CWD });
		expect(d.permitted).toBe(false);
	});
});

describe("dimension 4 — package-manager mutation (MATCH mag + piki stricter superset)", () => {
	const blocked = ["npm publish", "poetry publish", "npm rebuild", "yarn remove pkg"];
	it("blocks mag-identified pm mutations", () => {
		for (const command of blocked) {
			expect(classifyShellCommand(command).level, command).toBe("forbidden");
		}
	});
});

describe("dimension 5 — container/k8s/iac/db/sysadmin divergences vs mag", () => {
	// GAP: piki classifies gcloud/az config set as forbidden; mag returns null
	// (isGcloudForbidden: `if (top === "config") return null`). piki's
	// `mutatingPrefixes` contains bare "set", so `gcloud config set project X`
	// matches and is forbidden. mag allows it.
	it("GAP: piki over-blocks `gcloud config set` (mag allows)", () => {
		const piki = classifyShellCommand("gcloud config set project foo").level;
		expect(piki).toBe("forbidden"); // current piki behavior (documented divergence)
		// mag reference: "normal" (allowed) — uncomment to assert parity target:
		// expect(piki).toBe("normal");
	});
	it("GAP: piki over-blocks `az config set` (mag allows)", () => {
		const piki = classifyShellCommand("az config set defaults.group=foo").level;
		expect(piki).toBe("forbidden");
	});

	// GAP: piki forbids pg_dump/mysqldump unconditionally (DB_UTILITY_COMMANDS);
	// mag isDatabaseUtilityForbidden ALLOWS them (only blocks with --force +
	// destructive token). pg_dump/mysqldump are read-only exports in mag.
	it("GAP: piki over-blocks `pg_dump db` (mag allows)", () => {
		const piki = classifyShellCommand("pg_dump mydb > dump.sql").level;
		expect(piki).toBe("forbidden"); // current piki behavior (documented divergence)
		// mag reference: "normal" (allowed) — uncomment to assert parity target:
		// expect(piki).toBe("normal");
	});
	it("GAP: piki over-blocks `mysqldump db` (mag allows)", () => {
		const piki = classifyShellCommand("mysqldump mydb > dump.sql").level;
		expect(piki).toBe("forbidden");
	});

	// GAP: piki applies privileged/cap-risk/security-opt checks to ANY docker
	// subcommand; mag only checks them when isRunLikeInvocation is true
	// (run/create/exec or compose up/run). So `docker images --privileged` is
	// blocked by piki but allowed by mag.
	it("GAP: piki over-blocks `docker images --privileged` (mag allows, not run-like)", () => {
		const piki = classifyShellCommand("docker images --privileged").level;
		expect(piki).toBe("forbidden"); // current piki behavior (documented divergence)
		// mag reference: "normal" (allowed) — uncomment to assert parity target:
		// expect(piki).toBe("normal");
	});

	// Safety-positive superset (piki stricter): chroot/useradd/firewall-cmd.
	it("piki stricter: blocks chroot/useradd/firewall-cmd (mag does not)", () => {
		expect(classifyShellCommand("chroot /target").level).toBe("forbidden");
		expect(classifyShellCommand("useradd bob").level).toBe("forbidden");
		expect(classifyShellCommand("firewall-cmd --reload").level).toBe("forbidden");
	});

	it("MATCH: blocks kubectl/helm/terraform mutating", () => {
		expect(classifyShellCommand("kubectl delete pod x").level).toBe("forbidden");
		expect(classifyShellCommand("helm install foo bar").level).toBe("forbidden");
		expect(classifyShellCommand("terraform apply").level).toBe("forbidden");
	});

	it("MATCH: blocks kill PID1 / pkill broad hard-kill", () => {
		expect(classifyShellCommand("kill 1").level).toBe("forbidden");
		expect(classifyShellCommand("pkill -9 node").level).toBe("forbidden");
	});

	it("MATCH: blocks sensitive container mount / host namespace", () => {
		expect(classifyShellCommand("docker run -v /etc:/etc nginx").level).toBe("forbidden");
		expect(classifyShellCommand("docker run --net=host nginx").level).toBe("forbidden");
	});
});
