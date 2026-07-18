/**
 * Focused parity tests for the piki-vs-mag behavioral gaps addressed in the
 * consolidated parity fix plan:
 *   T1  git mutation classification (`-c`, `--output`, branch rename)
 *   T3  in-cwd mass-destructive allowed, escape denied
 *   T4  package-manager mutation blocking
 *   L1  container/IAC/sysadmin completeness (nerdctl, helm, db-utility)
 */

import { describe, expect, it } from "vitest";
import { evaluatePermission } from "../../src/core/permissions/permission-gate.ts";
import { classifyShellCommand, isGitMutation } from "../../src/core/permissions/shell-classifier.ts";

const CWD = "/home/user/project";

describe("T1 — git mutation classification parity with mag", () => {
	it("blocks `git -c user.name=x status` (config override on readonly subcommand)", () => {
		expect(isGitMutation("git -c user.name=x status")).toBe(true);
		const d = evaluatePermission("bash", { command: "git -c user.name=x status" }, { cwd: CWD });
		expect(d.permitted).toBe(false);
	});

	it("blocks `git status --output=f` (unsafe output flag)", () => {
		expect(isGitMutation("git status --output=f")).toBe(true);
		const d = evaluatePermission("bash", { command: "git status --output=f" }, { cwd: CWD });
		expect(d.permitted).toBe(false);
	});

	it("blocks `git branch -m old new` (rename)", () => {
		expect(isGitMutation("git branch -m old new")).toBe(true);
	});

	it("still allows read-only git subcommands", () => {
		for (const command of [
			"git status",
			"git log",
			"git diff",
			"git show HEAD",
			"git rev-parse HEAD",
			"git branch",
		]) {
			expect(isGitMutation(command), command).toBe(false);
		}
	});

	it("classifyShellCommand marks config/unsafe git as forbidden", () => {
		expect(classifyShellCommand("git -c user.name=x status").level).toBe("forbidden");
		expect(classifyShellCommand("git status --output=f").level).toBe("forbidden");
	});
});

describe("T3 — in-cwd mass-destructive allowed, escape denied (mag denyMassDestructiveIn)", () => {
	it("allows `rm -rf ./build` within cwd", () => {
		const d = evaluatePermission("bash", { command: "rm -rf ./build" }, { cwd: CWD });
		expect(d.permitted).toBe(true);
	});

	it("denies `rm -rf /etc/build` (escapes protected roots)", () => {
		const d = evaluatePermission("bash", { command: "rm -rf /etc/build" }, { cwd: CWD });
		expect(d.permitted).toBe(false);
		expect(d.reason).toMatch(/outside allowed directories|protected directories|system paths/i);
	});

	it("allows `rm -rf /tmp/x` (alpha22 honors /tmp outside-prefix exemption)", () => {
		const d = evaluatePermission("bash", { command: "rm -rf /tmp/x" }, { cwd: CWD });
		expect(d.permitted).toBe(true);
	});

	it("allows `rm -rf <cwd>/x` (absolute path within cwd is allowed)", () => {
		const d = evaluatePermission("bash", { command: "rm -rf /home/user/project/x" }, { cwd: CWD });
		expect(d.permitted).toBe(true);
	});

	it("denies `rm -rf ~/.piki/x` (protected piki home root)", () => {
		const d = evaluatePermission("bash", { command: "rm -rf ~/.piki/x" }, { cwd: CWD });
		expect(d.permitted).toBe(false);
		expect(d.reason).toMatch(/protected directories/i);
	});
});

describe("T4 — package-manager mutation blocking (mag isLangPackageManagerForbidden)", () => {
	const blocked = ["npm publish", "poetry publish", "npm rebuild", "yarn remove pkg", "pnpm unpublish", "cargo login"];
	const allowed = ["npm install", "npm run build", "yarn add pkg", "pip install pkg"];

	it("blocks publish/rebuild/remove/uninstall/login", () => {
		for (const command of blocked) {
			const d = evaluatePermission("bash", { command }, { cwd: CWD });
			expect(d.permitted, `expected "${command}" blocked`).toBe(false);
		}
	});

	it("allows install/add/build", () => {
		for (const command of allowed) {
			const d = evaluatePermission("bash", { command }, { cwd: CWD });
			expect(d.permitted, `expected "${command}" allowed`).toBe(true);
		}
	});

	it("classifyShellCommand marks package-manager mutations forbidden", () => {
		expect(classifyShellCommand("npm publish").level).toBe("forbidden");
		expect(classifyShellCommand("npm install").level).toBe("normal");
	});
});

describe("L1 — container/IAC/sysadmin completeness", () => {
	it("blocks nerdctl (container runtime)", () => {
		expect(classifyShellCommand("nerdctl push myregistry/img").level).toBe("forbidden");
		expect(classifyShellCommand("nerdctl run --privileged nginx").level).toBe("forbidden");
	});

	it("blocks helm mutating subcommands", () => {
		for (const command of ["helm install foo bar", "helm upgrade foo bar", "helm uninstall foo"]) {
			expect(classifyShellCommand(command).level, command).toBe("forbidden");
		}
	});

	it("allows helm read-style subcommands", () => {
		expect(classifyShellCommand("helm list").level).toBe("normal");
		expect(classifyShellCommand("helm get values foo").level).toBe("normal");
	});

	it("blocks db-utility commands (pg_dump/createdb/dropdb/mysqldump)", () => {
		for (const command of ["pg_dump db", "createdb newdb", "dropdb olddb", "mysqldump db"]) {
			expect(classifyShellCommand(command).level, command).toBe("forbidden");
		}
	});

	it("DB shells still blocked (piki superset preserved)", () => {
		expect(classifyShellCommand("psql -c 'SELECT 1'").level).toBe("forbidden");
		expect(classifyShellCommand("mongo").level).toBe("forbidden");
		expect(classifyShellCommand("sqlcmd -Q 'SELECT 1'").level).toBe("forbidden");
	});
});
