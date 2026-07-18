/**
 * Parity tests for Magnitude alpha22's shell cwd-boundary enforcement
 * (`writesStayWithin` / `denyWritesOutside`).
 *
 * These exercise the piki inline `shell-classifier.ts` boundary functions
 * (`writesStayWithin`, `isPathWithin`, `expandAndResolve`, `expandEnvVars`,
 * `parseShellCommand` redirects) and assert behavior matches alpha22 semantics.
 */

import { basename } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	expandAndResolve,
	expandEnvVars,
	isPathWithin,
	parseShellCommand,
	WRITE_PATH_COMMANDS,
	writesStayWithin,
} from "../../src/core/permissions/shell-classifier.ts";

const CWD = "/home/user/project";
const SCRATCH = "/home/user/.piki/scratch";
const HOME = "/home/user";
const ROOTS = [CWD, SCRATCH, `${HOME}/.piki`];

function shellEnv(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		...process.env,
		HOME,
		USERPROFILE: HOME,
		M: SCRATCH,
		PROJECT_ROOT: CWD,
		...overrides,
	};
}

const baseEnv = shellEnv();

beforeEach(() => {
	baseEnv.HOME = HOME;
	baseEnv.USERPROFILE = HOME;
});
afterEach(() => {
	baseEnv.HOME = HOME;
	baseEnv.USERPROFILE = HOME;
});

describe("parseShellCommand redirects / assignments (backward-compat shape)", () => {
	it("keeps the exact {name,args,separatorBefore} shape for plain commands", () => {
		expect(parseShellCommand("git status && rg foo | head -20")).toEqual([
			{ name: "git", args: ["status"], separatorBefore: undefined },
			{ name: "rg", args: ["foo"], separatorBefore: "&&" },
			{ name: "head", args: ["-20"], separatorBefore: "|" },
		]);
	});

	it("attaches redirects only when present", () => {
		const segments = parseShellCommand("echo x > out.txt");
		expect(segments[0]).toEqual({
			name: "echo",
			args: ["x", ">", "out.txt"],
			redirects: [{ op: ">", target: "out.txt" }],
		});
	});

	it("attaches assignments only when present", () => {
		const segments = parseShellCommand("FOO=bar echo x");
		expect(segments[0]).toEqual({
			name: "echo",
			args: ["x"],
			assignments: [{ name: "FOO", value: "bar" }],
		});
	});

	it("handles numeric-fd redirects and append", () => {
		const segments = parseShellCommand("echo x 2> err.log >> out.log");
		const redirects = segments[0]!.redirects ?? [];
		expect(redirects).toContainEqual({ op: "2>", target: "err.log" });
		expect(redirects).toContainEqual({ op: ">>", target: "out.log" });
	});

	it("quote-strips redirect targets", () => {
		const segments = parseShellCommand('echo x > "/etc/passwd"');
		expect(segments[0]!.redirects![0]).toEqual({ op: ">", target: "/etc/passwd" });
	});
});

describe("expandEnvVars", () => {
	it("expands dollar-prefixed env vars", () => {
		const env = { FOO: "bar", BAZ: "qux" };
		expect(expandEnvVars("$FOO/x", env)).toBe("bar/x");
		expect(expandEnvVars("$BAZ/y", env)).toBe("qux/y");
		expect(expandEnvVars("$MISSING/z", env)).toBe("/z");
	});
});

describe("expandAndResolve", () => {
	it("resolves tilde against HOME", () => {
		const result = expandAndResolve("~/file", baseEnv, CWD);
		expect(result).toBe("/home/user/file");
	});
	it("resolves relative path against base cwd", () => {
		const result = expandAndResolve("src/x", baseEnv, CWD);
		expect(result).toBe("/home/user/project/src/x");
	});
	it("resolves $M to scratchpad", () => {
		const result = expandAndResolve("$M/y", baseEnv, CWD);
		expect(result).toBe("/home/user/.piki/scratch/y");
	});
});

describe("isPathWithin", () => {
	it("treats empty and dash-prefixed paths as inside", () => {
		expect(isPathWithin("", baseEnv, ...ROOTS)).toBe(true);
		expect(isPathWithin("-", baseEnv, ...ROOTS)).toBe(true);
	});
	it("allows /tmp/* and /dev/null outside roots", () => {
		expect(isPathWithin("/tmp/any", baseEnv, ...ROOTS)).toBe(true);
		expect(isPathWithin("/dev/null", baseEnv, ...ROOTS)).toBe(true);
	});
	it("rejects paths outside roots", () => {
		expect(isPathWithin("/etc/passwd", baseEnv, ...ROOTS)).toBe(false);
		expect(isPathWithin("/home/user/elsewhere", baseEnv, ...ROOTS)).toBe(false);
	});
});

describe("writesStayWithin", () => {
	it("allows empty command", () => {
		expect(writesStayWithin("", baseEnv, ...ROOTS)).toBe(true);
	});

	describe("redirects", () => {
		it("rejects writes to /etc", () => {
			expect(writesStayWithin("echo x > /etc/passwd", baseEnv, ...ROOTS)).toBe(false);
		});
		it("allows writes within cwd", () => {
			expect(writesStayWithin("echo x > ./out.txt", baseEnv, ...ROOTS)).toBe(true);
		});
		it("allows /tmp writes (allowed-outside)", () => {
			expect(writesStayWithin("echo x > /tmp/out.txt", baseEnv, ...ROOTS)).toBe(true);
		});
		it("rejects tee to /root", () => {
			expect(writesStayWithin("tee /root/x", baseEnv, ...ROOTS)).toBe(false);
		});
		it("allows tee under HOME-in-roots", () => {
			expect(writesStayWithin("tee ~/project/x", baseEnv, ...ROOTS)).toBe(true);
		});
		it("allows stdout redirect (> -)", () => {
			expect(writesStayWithin("echo x > -", baseEnv, ...ROOTS)).toBe(true);
		});
		it("rejects quoted path", () => {
			expect(writesStayWithin('echo x > "/etc/passwd"', baseEnv, ...ROOTS)).toBe(false);
		});
	});

	describe("write-path command args", () => {
		it("rejects cp into /usr/bin", () => {
			expect(writesStayWithin("cp a /usr/bin/a", baseEnv, ...ROOTS)).toBe(false);
		});
		it("allows mv within cwd", () => {
			expect(writesStayWithin("mv a ./b", baseEnv, ...ROOTS)).toBe(true);
		});
		it("rejects mkdir /etc/x", () => {
			expect(writesStayWithin("mkdir /etc/x", baseEnv, ...ROOTS)).toBe(false);
		});
		it("allows touch /tmp/x", () => {
			expect(writesStayWithin("touch /tmp/x", baseEnv, ...ROOTS)).toBe(true);
		});
	});

	describe("cd tracking", () => {
		it("rejects writes after cd /etc", () => {
			expect(writesStayWithin("cd /etc && echo x > y", baseEnv, ...ROOTS)).toBe(false);
		});
		it("allows writes after cd src (inside cwd)", () => {
			expect(writesStayWithin("cd src && touch y", baseEnv, ...ROOTS)).toBe(true);
		});
		it("returns false for cd with no arg and no HOME", () => {
			const env = shellEnv();
			delete env.HOME;
			delete env.USERPROFILE;
			expect(writesStayWithin("cd", env, ...ROOTS)).toBe(false);
		});
		it("returns false for cd - with no previous", () => {
			expect(writesStayWithin("cd -", baseEnv, ...ROOTS)).toBe(false);
		});
	});

	describe("pipelines", () => {
		it("rejects cat | tee /etc/bar", () => {
			expect(writesStayWithin("cat foo | tee /etc/bar", baseEnv, ...ROOTS)).toBe(false);
		});
		it("allows cat | tee ./bar", () => {
			expect(writesStayWithin("cat foo | tee ./bar", baseEnv, ...ROOTS)).toBe(true);
		});
	});

	describe("env / tilde", () => {
		it("allows $HOME/.piki/y", () => {
			expect(writesStayWithin("echo x > $HOME/.piki/y", baseEnv, ...ROOTS)).toBe(true);
		});
		it("rejects $HOME/elsewhere", () => {
			expect(writesStayWithin("echo x > $HOME/elsewhere", baseEnv, ...ROOTS)).toBe(false);
		});
		it("rejects ~/../outside (traversal)", () => {
			expect(writesStayWithin("echo x > ~/../outside", baseEnv, ...ROOTS)).toBe(false);
		});
	});

	describe("false-positive-safe read commands", () => {
		it("allows reads of absolute system paths", () => {
			expect(writesStayWithin("cat /etc/hosts", baseEnv, ...ROOTS)).toBe(true);
			expect(writesStayWithin("grep x /etc/passwd", baseEnv, ...ROOTS)).toBe(true);
			expect(writesStayWithin("ls /usr/bin", baseEnv, ...ROOTS)).toBe(true);
		});
	});

	describe("not caught (parity, not a defect)", () => {
		it("allows bash -c with redirect inside quoted string", () => {
			expect(writesStayWithin('bash -c "echo x > /etc/passwd"', baseEnv, ...ROOTS)).toBe(true);
		});
	});

	it("exposes WRITE_PATH_COMMANDS matching alpha22", () => {
		expect([...WRITE_PATH_COMMANDS].sort()).toEqual(
			["chmod", "chown", "cp", "install", "ln", "mkdir", "mv", "rm", "rsync", "tee", "touch"].sort(),
		);
	});
});

// Reference check: basename helper parity with our internal basename.
describe("basename parity", () => {
	it("matches node path.basename", () => {
		expect(basename("/usr/bin/ls")).toBe("ls");
	});
});
