import { describe, expect, test } from "vitest";
import { formatEnvironmentSnapshot } from "../src/core/environment-snapshot.ts";

describe("formatEnvironmentSnapshot", () => {
	test("formats provided environment fields without env vars", () => {
		const snapshot = formatEnvironmentSnapshot({
			date: "2026-06-21",
			cwd: "/repo/packages/coding-agent",
			workspaceRoot: "/repo",
			os: "linux",
			hostname: "devhost",
			username: "devuser",
			gitBranch: "feature/reliability",
			repoUrl: "git@example.com:org/repo.git",
			rootListing: ["package.json", "packages", "README.md"],
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
		expect(snapshot).toContain("  - package.json");
		expect(snapshot).not.toContain("process.env");
	});

	test("bounds root listing and strips control characters", () => {
		const snapshot = formatEnvironmentSnapshot({
			date: "2026-06-21",
			cwd: "/repo",
			workspaceRoot: "/repo",
			os: "linux",
			hostname: "dev\u0000host",
			username: "devuser",
			gitBranch: "main",
			repoUrl: null,
			rootListing: Array.from({ length: 25 }, (_, index) => `entry-${index}\u0000`),
		});

		expect(snapshot).toContain("- hostname: devhost");
		expect(snapshot).toContain("  - entry-0");
		expect(snapshot).toContain("  - entry-19");
		expect(snapshot).not.toContain("entry-20");
		expect(snapshot).not.toContain("\u0000");
	});

	test("omits optional user fields and marks unavailable git/listing fields", () => {
		const snapshot = formatEnvironmentSnapshot({
			date: "2026-06-21",
			cwd: "/tmp/no-repo",
			workspaceRoot: "/tmp/no-repo",
			os: "linux",
			hostname: null,
			username: null,
			gitBranch: null,
			repoUrl: null,
			rootListing: [],
		});

		expect(snapshot).not.toContain("hostname:");
		expect(snapshot).not.toContain("username:");
		expect(snapshot).toContain("- git_branch: (unavailable)");
		expect(snapshot).toContain("- repo_url: (unavailable)");
		expect(snapshot).toContain("- root_listing: (unavailable)");
	});
});
