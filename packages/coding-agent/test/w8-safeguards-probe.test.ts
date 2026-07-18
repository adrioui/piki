import { describe, expect, it } from "vitest";

import { evaluatePermission } from "../src/core/permissions/permission-gate.ts";
import { classifyShellCommand, isGitMutation } from "../src/core/permissions/shell-classifier.ts";

const CWD = "/home/user/project";
const SCRATCH = "/home/user/.piki";

describe("W8 safeguards: leader write/edit cwd boundary (G1/G2 re-verify)", () => {
	// Leader now passes roleId:"leader" + scratchpadPath (agent-session.ts:587-593).
	const leaderOpts = {
		roleId: "leader" as const,
		scratchpadPath: SCRATCH,
		cwd: CWD,
		interactive: true,
	};

	it("leader write outside cwd is rejected (was the G1 gap)", () => {
		const r = evaluatePermission("write", { path: "/etc/passwd" }, leaderOpts);
		expect(r.permitted).toBe(false);
		expect(r.reason).toContain("Cannot write files outside allowed directories");
	});

	it("leader write inside cwd is allowed", () => {
		const r = evaluatePermission("write", { path: "/home/user/project/foo.txt" }, leaderOpts);
		expect(r.permitted).toBe(true);
	});

	it("leader write into scratchpad is allowed", () => {
		const r = evaluatePermission("write", { path: "/home/user/.piki/notes.md" }, leaderOpts);
		expect(r.permitted).toBe(true);
	});

	it("leader edit outside cwd is rejected", () => {
		const r = evaluatePermission("edit", { path: "/home/user/elsewhere/x.txt", old: "a", new: "b" }, leaderOpts);
		expect(r.permitted).toBe(false);
	});

	it("leader edit into /tmp is allowed (mag /tmp outside-prefix exemption)", () => {
		const r = evaluatePermission("edit", { path: "/tmp/x", old: "a", new: "b" }, leaderOpts);
		expect(r.permitted).toBe(true);
	});

	it("--disable-cwd-safeguards now lifts leader write boundary (G2)", () => {
		const r = evaluatePermission(
			"write",
			{ path: "/etc/passwd" },
			{
				...leaderOpts,
				disableCwdSafeguards: true,
			},
		);
		expect(r.permitted).toBe(true);
	});

	it("disableShellSafeguards does NOT lift cwd boundary (independent flags)", () => {
		const r = evaluatePermission(
			"write",
			{ path: "/etc/passwd" },
			{
				...leaderOpts,
				disableShellSafeguards: true,
			},
		);
		expect(r.permitted).toBe(false);
	});
});

describe("W8 safeguards: mass-destructive two-phase (GAP #5 re-verify)", () => {
	it("rm -rf in cwd ALLOWED (mag denyMassDestructiveIn phase-1)", () => {
		const r = evaluatePermission(
			"bash",
			{ command: "rm -rf ./build" },
			{
				roleId: "leader",
				cwd: CWD,
				scratchpadPath: SCRATCH,
				interactive: true,
			},
		);
		expect(r.permitted).toBe(true);
	});

	it("rm -rf in scratchpad (~/.piki) ALLOWED (phase-1 non-protected roots include scratchpad)", () => {
		const r = evaluatePermission(
			"bash",
			{ command: "rm -rf /home/user/.piki/x" },
			{
				roleId: "leader",
				cwd: CWD,
				scratchpadPath: SCRATCH,
				interactive: true,
			},
		);
		expect(r.permitted).toBe(true);
	});

	it("rm -rf escaping ALL roots DENIED by cwd write-boundary", () => {
		const r = evaluatePermission(
			"bash",
			{ command: "rm -rf /home/user/elsewhere" },
			{
				roleId: "leader",
				cwd: CWD,
				scratchpadPath: SCRATCH,
				interactive: true,
			},
		);
		expect(r.permitted).toBe(false);
		expect(r.reason).toContain("outside allowed directories");
	});

	it("rm -rf /tmp/x ALLOWED (mag honors /tmp outside-prefix exemption)", () => {
		const r = evaluatePermission(
			"bash",
			{ command: "rm -rf /tmp/x" },
			{
				roleId: "leader",
				cwd: CWD,
				scratchpadPath: SCRATCH,
				interactive: true,
			},
		);
		expect(r.permitted).toBe(true);
	});
});

describe("W8 safeguards: git classification (full-parity-tools:103 re-verify)", () => {
	it("git ls-files blocked (mag isGitReadOnly default=false)", () => {
		expect(isGitMutationProbe("git ls-files")).toBe(true);
	});
	it("git -c user.name=x status is mutating (mag hasConfigOverride)", () => {
		expect(isGitMutationProbe("git -c user.name=x status")).toBe(true);
	});
	it("git status --output=f is mutating (mag UNSAFE_SUBCOMMAND_FLAGS)", () => {
		expect(isGitMutationProbe("git status --output=f")).toBe(true);
	});
});

function isGitMutationProbe(cmd: string): boolean {
	const c = classifyShellCommand(cmd);
	if (c.level === "forbidden") return true;
	if (c.level === "readonly") return false;
	return true; // normal => not read-only => mag treats unknown as mutation
}

describe("W8 safeguards: package-manager parity (FIX-PM1 — G-PM1)", () => {
	// MATCH: publish-family blocked in both
	const bothForbidden = [
		"npm publish",
		"pnpm publish",
		"yarn publish",
		"bun publish",
		"poetry publish",
		"uv publish",
		"twine upload",
		"cargo publish",
	];
	// mag-parity publish/registry-mutation blocks that were previously missed by piki (G-PM1)
	const magForbidden = [
		"gem push",
		"gem yank",
		"mvn deploy",
		"npm deprecate foo",
		"npm owner add x",
		"npm owner rm x",
		"npm star",
		"npm adduser",
		"npm dist-tag add x 1.0",
		"npm dist-tag rm x 1.0",
		"npm access grant public x",
		"npm org set x team",
		"npm team create x",
		"npm token create",
		"npm token revoke abc",
		"npm hook add x",
		"yarn owner add x",
		"yarn tag rm x 1.0",
		"yarn npm publish",
		"cargo owner --add x",
		"cargo yank 1.0",
		"dotnet nuget push x",
		"dotnet nuget delete x",
		"mix hex.publish",
		"mix hex.retire",
		"mix hex.owner add x",
		"swift package-registry publish",
	];
	// piki STRICTER than mag (G-PM2): keep forbidden (regression guard)
	const pikiStricter = ["npm remove left-pad", "npm rebuild", "npm unlink", "npm logout"];

	it("publish-family blocked in both (MATCH)", () => {
		for (const c of bothForbidden) {
			expect(classifyShellCommand(c).level, c).toBe("forbidden");
		}
	});

	it("mag publish/registry-mutation blocks now forbidden (G-PM1 closed)", () => {
		for (const c of magForbidden) {
			expect(classifyShellCommand(c).level, `${c} should be forbidden per mag`).toBe("forbidden");
		}
	});

	it("flag-first publish still caught (defect-2: strip flags before nested match)", () => {
		expect(classifyShellCommand("npm --registry=x publish").level).toBe("forbidden");
		expect(classifyShellCommand("npm publish --registry=x").level).toBe("forbidden");
	});

	it("piki stricter: npm remove/rebuild/unlink/logout still blocked (G-PM2 regression)", () => {
		for (const c of pikiStricter) {
			expect(classifyShellCommand(c).level, c).toBe("forbidden");
		}
	});

	it("read-style package-manager commands remain allowed", () => {
		const allowed = ["npm install x", "npm run build", "npm test", "yarn add x", "cargo build", "pnpm add x"];
		for (const c of allowed) {
			expect(classifyShellCommand(c).level, c).not.toBe("forbidden");
		}
	});

	it("case-variant publish commands are blocked (F-PM-1 case fix)", () => {
		// mag lowercases positional tokens, so case variants must be caught.
		expect(classifyShellCommand("gem --silent Push").level).toBe("forbidden");
		expect(classifyShellCommand("gem --silent push").level).toBe("forbidden");
		expect(classifyShellCommand("npm --registry=x Publish").level).toBe("forbidden");
		expect(classifyShellCommand("Gradle clean Publish").level).toBe("forbidden");
		expect(classifyShellCommand("Gradle Clean Publish").level).toBe("forbidden");
		expect(classifyShellCommand("Npm Publish").level).toBe("forbidden");
	});

	it("gradle clean publish blocked; publishToMavenLocal still allowed (F-PM-2)", () => {
		expect(classifyShellCommand("gradle clean publish").level).toBe("forbidden");
		expect(classifyShellCommand("gradle publish").level).toBe("forbidden");
		expect(classifyShellCommand("gradle publishToMavenLocal").level).not.toBe("forbidden");
		expect(classifyShellCommand("gradle clean build").level).not.toBe("forbidden");
	});
});

describe("W8 safeguards: helm / container / DB (GAP #19 re-verify)", () => {
	it("helm install forbidden (piki now matches mag)", () => {
		expect(classifyShellCommand("helm install x y").level).toBe("forbidden");
	});
	it("helm repo add forbidden", () => {
		expect(classifyShellCommand("helm repo add x y").level).toBe("forbidden");
	});
	it("docker push forbidden", () => {
		expect(classifyShellCommand("docker push x").level).toBe("forbidden");
	});
	it("psql interactive shell forbidden", () => {
		expect(classifyShellCommand("psql").level).toBe("forbidden");
	});
	it("pg_dump forbidden (mag DB_UTILITY_TOOLS)", () => {
		expect(classifyShellCommand("pg_dump db").level).toBe("forbidden");
	});
});

describe("S10 safeguards: G1-G5 classifier parity fixes", () => {
	// G1: attached `-c` git config-injection forms (mag hasConfigOverride).
	it("git --config-env=foo status is not read-only / mutating (G1 regression)", () => {
		expect(isGitMutation("git --config-env=foo status")).toBe(true);
		expect(classifyShellCommand("git --config-env=foo status").level).not.toBe("readonly");
	});
	it("git -cfoo=bar status is mutating via attached -c form (G1 NEW gap)", () => {
		expect(isGitMutation("git -cfoo=bar status")).toBe(true);
		expect(classifyShellCommand("git -cfoo=bar status").level).not.toBe("readonly");
	});

	// G2: docker/podman --security-opt unconfined disables sandboxing.
	it("docker run --security-opt seccomp=unconfined is forbidden (G2)", () => {
		expect(classifyShellCommand("docker run --security-opt seccomp=unconfined img").level).toBe("forbidden");
	});
	it("docker run --security-opt=apparmor=unconfined is forbidden (G2)", () => {
		expect(classifyShellCommand("docker run --security-opt=apparmor=unconfined img").level).toBe("forbidden");
	});
	it("docker run --security-opt seccomp=profile.json is allowed (G2 negative)", () => {
		expect(classifyShellCommand("docker run --security-opt seccomp=profile.json img").level).not.toBe("forbidden");
	});
	it("podman --security-opt apparmor=unconfined is forbidden (G2)", () => {
		expect(classifyShellCommand("podman run --security-opt apparmor=unconfined img").level).toBe("forbidden");
	});

	// G3: docker compose down with destructive flags (flag-skipping corrected).
	it("docker compose down -v is forbidden (G3)", () => {
		expect(classifyShellCommand("docker compose down -v").level).toBe("forbidden");
	});
	it("docker compose down --volumes is forbidden (G3)", () => {
		expect(classifyShellCommand("docker compose down --volumes").level).toBe("forbidden");
	});
	it("docker compose -f docker-compose.yml down -v is forbidden (G3 leaked form)", () => {
		expect(classifyShellCommand("docker compose -f docker-compose.yml down -v").level).toBe("forbidden");
	});
	it("docker compose -f file.yml down --remove-orphans is forbidden (G3 leaked form)", () => {
		expect(classifyShellCommand("docker compose -f file.yml down --remove-orphans").level).toBe("forbidden");
	});
	it("docker compose down (no flags) is allowed (G3 negative)", () => {
		expect(classifyShellCommand("docker compose down").level).not.toBe("forbidden");
	});
	it("docker compose up -d is allowed (G3 negative)", () => {
		expect(classifyShellCommand("docker compose up -d").level).not.toBe("forbidden");
	});

	// G4: gcloud auth non-list subcommands (value-flag-skipping corrected).
	it("gcloud auth activate-service-account is forbidden (G4)", () => {
		expect(classifyShellCommand("gcloud auth activate-service-account").level).toBe("forbidden");
	});
	it("gcloud auth revoke is forbidden (G4)", () => {
		expect(classifyShellCommand("gcloud auth revoke").level).toBe("forbidden");
	});
	it("gcloud --project foo auth activate-service-account is forbidden (G4 leaked form)", () => {
		expect(classifyShellCommand("gcloud --project foo auth activate-service-account").level).toBe("forbidden");
	});
	it("gcloud --account bar auth revoke is forbidden (G4 leaked form)", () => {
		expect(classifyShellCommand("gcloud --account bar auth revoke").level).toBe("forbidden");
	});
	it("gcloud auth list is allowed (G4 negative)", () => {
		expect(classifyShellCommand("gcloud auth list").level).not.toBe("forbidden");
	});
	it("gcloud --project foo auth list is allowed (G4 negative leaked form)", () => {
		expect(classifyShellCommand("gcloud --project foo auth list").level).not.toBe("forbidden");
	});

	// G5: terraform workspace + pulumi stack nested destructive subcommands.
	it("terraform workspace delete x is forbidden (G5)", () => {
		expect(classifyShellCommand("terraform workspace delete x").level).toBe("forbidden");
	});
	it("terraform workspace select x is forbidden (G5)", () => {
		expect(classifyShellCommand("terraform workspace select x").level).toBe("forbidden");
	});
	it("terraform workspace new dev is forbidden (G5)", () => {
		expect(classifyShellCommand("terraform workspace new dev").level).toBe("forbidden");
	});
	it("terraform workspace list is allowed (G5 negative)", () => {
		expect(classifyShellCommand("terraform workspace list").level).not.toBe("forbidden");
	});
	it("pulumi stack rm x is forbidden (G5)", () => {
		expect(classifyShellCommand("pulumi stack rm x").level).toBe("forbidden");
	});
	it("pulumi stack init x is forbidden (G5)", () => {
		expect(classifyShellCommand("pulumi stack init x").level).toBe("forbidden");
	});
	it("pulumi stack ls is allowed (G5 negative)", () => {
		expect(classifyShellCommand("pulumi stack ls").level).not.toBe("forbidden");
	});
});
