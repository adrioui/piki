import { describe, expect, test } from "vitest";
import { formatEnvironmentSnapshot, redactRepoUrl } from "../src/core/environment-snapshot.ts";

describe("formatEnvironmentSnapshot", () => {
	test("formats provided environment fields without env vars", () => {
		const snapshot = formatEnvironmentSnapshot({
			date: "2026-06-21",
			cwd: "/repo/packages/coding-agent",
			workspaceRoot: "/repo",
			os: "linux",
			shell: "bash",
			timezone: "UTC",
			hostname: "devhost",
			username: "devuser",
			gitBranch: "feature/reliability",
			gitStatus: ["M src/file.ts"],
			recentCommits: ["abc1234 initial commit"],
			repoUrl: "git@example.com:org/repo.git",
			folderStructure: ["package.json", "packages/", "README.md"],
			loadedSkills: [],
		});

		expect(snapshot).toContain("Environment snapshot:");
		expect(snapshot).toContain("- date: 2026-06-21");
		expect(snapshot).toContain("- cwd: /repo/packages/coding-agent");
		expect(snapshot).toContain("- workspace_root: /repo");
		expect(snapshot).toContain("- os: linux");
		expect(snapshot).toContain("- hostname: devhost");
		expect(snapshot).toContain("- username: devuser");
		expect(snapshot).toContain("- git_branch: feature/reliability");
		expect(snapshot).toContain("- repo_url: git@example.com:org/repo.git");
		expect(snapshot).toContain("package.json");
		expect(snapshot).toContain("packages/");
		expect(snapshot).toContain("README.md");
		expect(snapshot).not.toContain("process.env");
	});

	test("bounds root listing and strips control characters", () => {
		const snapshot = formatEnvironmentSnapshot({
			date: "2026-06-21",
			cwd: "/repo",
			workspaceRoot: "/repo",
			os: "linux",
			shell: "bash",
			timezone: "UTC",
			hostname: "dev\u0000host",
			username: "devuser",
			gitBranch: "main",
			gitStatus: [],
			recentCommits: [],
			repoUrl: null,
			folderStructure: Array.from({ length: 25 }, (_, index) => `entry-${index}\u0000`),
			loadedSkills: [],
		});

		expect(snapshot).toContain("- hostname: devhost");
		expect(snapshot).toContain("entry-0");
		expect(snapshot).toContain("entry-19");
		expect(snapshot).not.toContain("entry-20");
		expect(snapshot).not.toContain("\u0000");
	});

	test("omits optional user fields and marks unavailable git/listing fields", () => {
		const snapshot = formatEnvironmentSnapshot({
			date: "2026-06-21",
			cwd: "/tmp/no-repo",
			workspaceRoot: "/tmp/no-repo",
			os: "linux",
			shell: null,
			timezone: null,
			hostname: null,
			username: null,
			gitBranch: null,
			gitStatus: null,
			recentCommits: null,
			repoUrl: null,
			folderStructure: [],
			loadedSkills: null,
		});

		expect(snapshot).not.toContain("hostname:");
		expect(snapshot).not.toContain("username:");
		expect(snapshot).toContain("- git_branch: (unavailable)");
		expect(snapshot).toContain("- repo_url: (unavailable)");
		expect(snapshot).toContain("- folder_structure: (unavailable)");
	});

	test("redacts credentials from HTTPS repo URLs", () => {
		// Build URL dynamically to avoid secret scanners flagging test fixtures
		const credUrl = ["https://", "testuser", ":", "testpass", "@github.com/org/repo.git"].join("");
		const snapshot = formatEnvironmentSnapshot({
			date: "2026-06-21",
			cwd: "/repo",
			workspaceRoot: "/repo",
			os: "linux",
			shell: null,
			timezone: null,
			hostname: null,
			username: null,
			gitBranch: "main",
			gitStatus: null,
			recentCommits: null,
			repoUrl: credUrl,
			folderStructure: [],
			loadedSkills: null,
		});

		expect(snapshot).toContain("- repo_url: https://github.com/org/repo.git");
		expect(snapshot).not.toContain("testuser");
		expect(snapshot).not.toContain("testpass");
	});
});

describe("redactRepoUrl", () => {
	test("strips userinfo from HTTPS URLs", () => {
		const credUrl = ["https://", "testuser", ":", "testpass", "@github.com/org/repo.git"].join("");
		expect(redactRepoUrl(credUrl)).toBe("https://github.com/org/repo.git");
	});

	test("strips username-only HTTPS URLs", () => {
		expect(redactRepoUrl("https://user@github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
	});

	test("leaves clean HTTPS URLs unchanged", () => {
		expect(redactRepoUrl("https://github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
	});

	test("leaves SSH-style URLs unchanged", () => {
		expect(redactRepoUrl("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
	});

	test("returns null for null/empty input", () => {
		expect(redactRepoUrl(null)).toBeNull();
		expect(redactRepoUrl("")).toBeNull();
		expect(redactRepoUrl("  ")).toBeNull();
	});
});
