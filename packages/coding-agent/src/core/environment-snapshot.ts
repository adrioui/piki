/**
 * Bounded environment snapshot for the system prompt.
 *
 * Inspired by Amp's `.tmp` environment block (workspace root, OS, hostname,
 * git branch, repo URL, root listing) and tuned for open-weight coding agents
 * that benefit from deterministic workspace context.
 *
 * Design rules:
 * - Read-only: never writes, never mutates the workspace.
 * - Bounded: every list is size-limited and stringified output is total-length bounded.
 * - Privacy: never include environment variables or secrets. Username/hostname
 *   are optional and can be omitted by passing `includeUserInfo: false`.
 * - Failure-tolerant: any single sub-query failure must not break the snapshot;
 *   omit the field with `(unavailable)` instead.
 * - Deterministic enough for tests: the `EnvironmentSnapshotProvider` interface
 *   lets tests inject fakes.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { hostname as osHostname, userInfo as osUserInfo, platform } from "node:os";
import { dirname, join } from "node:path";

/** Public shape of the snapshot. */
export interface EnvironmentSnapshot {
	date: string;
	cwd: string;
	workspaceRoot: string;
	os: string;
	shell: string | null;
	timezone: string | null;
	hostname: string | null;
	username: string | null;
	gitBranch: string | null;
	gitStatus: string[] | null;
	recentCommits: string[] | null;
	repoUrl: string | null;
	folderStructure: string[];
	loadedSkills: Array<{ name: string; description: string }> | null;
}

/**
 * Provider interface so tests can swap in deterministic implementations without
 * touching the file system or running git commands.
 */
export interface EnvironmentSnapshotProvider {
	readonly cwd: string;
	readonly date: string;
	readonly workspaceRoot: string;
	readonly os: string;
	readonly shell: string | null;
	readonly timezone: string | null;
	readonly hostname: string | null;
	readonly username: string | null;
	readonly gitBranch: string | null;
	readonly gitStatus: readonly string[] | null;
	readonly recentCommits: readonly string[] | null;
	readonly repoUrl: string | null;
	readonly folderStructure: readonly string[];
	readonly loadedSkills: ReadonlyArray<{ name: string; description: string }> | null;
}

export interface CollectEnvironmentSnapshotOptions {
	/** Working directory to snapshot. Defaults to process.cwd(). */
	cwd?: string;
	/** Override date (ISO yyyy-mm-dd). Defaults to today. */
	date?: string;
	/** Override hostname. Pass empty string to omit. */
	hostname?: string | null;
	/** Override username. Pass empty string to omit. */
	username?: string | null;
	/** Include username/hostname. Default true. */
	includeUserInfo?: boolean;
	/** Maximum depth for folder structure traversal. Default 2. */
	maxFolderDepth?: number;
	/** Maximum entries per directory in folder structure. Default 20. */
	maxFolderEntries?: number;
	/** Maximum git status lines. Default 50. */
	maxGitStatusLines?: number;
	/** Maximum recent commits. Default 10. */
	maxRecentCommits?: number;
	/** Loaded skills to include in snapshot. */
	loadedSkills?: Array<{ name: string; description: string }>;
}

/**
 * Default provider: queries the real environment.
 */
export function collectEnvironmentSnapshot(options: CollectEnvironmentSnapshotOptions = {}): EnvironmentSnapshot {
	const cwd = options.cwd ?? process.cwd();
	const date = options.date ?? todayIsoDate();
	const includeUserInfo = options.includeUserInfo ?? true;
	const maxFolderDepth = options.maxFolderDepth ?? 2;
	const maxFolderEntries = options.maxFolderEntries ?? 20;
	const maxGitStatusLines = options.maxGitStatusLines ?? 50;
	const maxRecentCommits = options.maxRecentCommits ?? 10;

	const hostname = includeUserInfo ? (options.hostname ?? safeHostname()) : null;
	const username = includeUserInfo ? (options.username ?? safeUsername()) : null;
	const workspaceRoot = findWorkspaceRoot(cwd);

	return {
		date,
		cwd,
		workspaceRoot,
		os: platform(),
		shell: readShell(),
		timezone: readTimezone(),
		hostname,
		username,
		gitBranch: readGitBranch(cwd),
		gitStatus: readGitStatus(cwd, maxGitStatusLines),
		recentCommits: readRecentCommits(cwd, maxRecentCommits),
		repoUrl: readRepoUrl(cwd),
		folderStructure: readFolderStructure(workspaceRoot, maxFolderDepth, maxFolderEntries),
		loadedSkills: options.loadedSkills ?? null,
	};
}

/**
 * Format the snapshot into a deterministic text block appended to the system
 * prompt. Output is bounded to keep the prompt small.
 */
export function formatEnvironmentSnapshot(provider: EnvironmentSnapshotProvider): string {
	const lines: string[] = [];
	const hostname = sanitizeField(provider.hostname);
	const username = sanitizeField(provider.username);
	const gitBranch = sanitizeField(provider.gitBranch);
	const repoUrl = sanitizeField(provider.repoUrl);
	const shell = sanitizeField(provider.shell);
	const timezone = sanitizeField(provider.timezone);

	lines.push("Environment snapshot:");
	lines.push(`- date: ${sanitizeField(provider.date) ?? "(unavailable)"}`);
	lines.push(`- cwd: ${sanitizeField(provider.cwd) ?? "(unavailable)"}`);
	lines.push(`- workspace_root: ${sanitizeField(provider.workspaceRoot) ?? "(unavailable)"}`);
	lines.push(`- os: ${sanitizeField(provider.os) ?? "(unavailable)"}`);
	if (shell) {
		lines.push(`- shell: ${shell}`);
	}
	if (timezone) {
		lines.push(`- timezone: ${timezone}`);
	}
	if (hostname) {
		lines.push(`- hostname: ${hostname}`);
	}
	if (username) {
		lines.push(`- username: ${username}`);
	}
	lines.push(`- git_branch: ${gitBranch ?? "(unavailable)"}`);
	lines.push(`- repo_url: ${repoUrl ?? "(unavailable)"}`);

	if (provider.gitStatus && provider.gitStatus.length > 0) {
		lines.push("- git_status:");
		for (const status of provider.gitStatus) {
			lines.push(`  ${status}`);
		}
	}

	if (provider.recentCommits && provider.recentCommits.length > 0) {
		lines.push("- recent_commits:");
		for (const commit of provider.recentCommits) {
			lines.push(`  ${commit}`);
		}
	}

	if (provider.folderStructure.length > 0) {
		lines.push("- folder_structure:");
		// Limit to 20 entries and sanitize
		for (const entry of provider.folderStructure.slice(0, 20)) {
			lines.push(sanitizeField(entry) ?? "");
		}
		if (provider.folderStructure.length > 20) {
			lines.push(`... (${provider.folderStructure.length - 20} more entries)`);
		}
	} else {
		lines.push("- folder_structure: (unavailable)");
	}

	if (provider.loadedSkills && provider.loadedSkills.length > 0) {
		lines.push("- loaded_skills:");
		for (const skill of provider.loadedSkills) {
			lines.push(`  - ${skill.name}: ${skill.description}`);
		}
	}

	return lines.join("\n");
}

// --- internal helpers --------------------------------------------------------

function todayIsoDate(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function safeHostname(): string | null {
	try {
		const value = osHostname();
		return sanitizeField(value);
	} catch {
		return null;
	}
}

function safeUsername(): string | null {
	try {
		const info = osUserInfo();
		return sanitizeField(info.username);
	} catch {
		return null;
	}
}

/** Strip control chars and clamp length. Empty after sanitization => null. */
function sanitizeField(value: string | undefined | null): string | null {
	if (!value) return null;
	const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
	if (!cleaned) return null;
	return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/**
 * Walk upward from `cwd` looking for a directory containing a `.git` entry.
 * Fall back to `cwd` if no git root is found. Hard cap of 32 hops to avoid
 * runaway traversal.
 */
function findWorkspaceRoot(cwd: string): string {
	const maxHops = 32;
	let current = cwd;
	for (let i = 0; i < maxHops; i++) {
		try {
			statSync(join(current, ".git"));
			return current;
		} catch {
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	return cwd;
}

/**
 * Read the current short git branch (if any). Uses spawnSync with a hard 1s
 * timeout to avoid blocking the prompt build.
 */
function readGitBranch(cwd: string): string | null {
	const result = spawnSync("git", ["-C", cwd, "symbolic-ref", "--short", "HEAD"], {
		encoding: "utf8",
		timeout: 1000,
	});
	if (result.status !== 0) return null;
	const branch = sanitizeField(result.stdout);
	return branch;
}

function readRepoUrl(cwd: string): string | null {
	const result = spawnSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
		encoding: "utf8",
		timeout: 1000,
	});
	if (result.status !== 0) return null;
	return sanitizeField(result.stdout);
}

/**
 * Read the current shell from the SHELL environment variable.
 */
function readShell(): string | null {
	const shell = process.env.SHELL;
	if (!shell) return null;
	// Extract just the shell name (e.g., /bin/bash -> bash)
	const shellName = shell.split("/").pop();
	return sanitizeField(shellName);
}

/**
 * Read the current timezone.
 */
function readTimezone(): string | null {
	try {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return sanitizeField(timezone);
	} catch {
		return null;
	}
}

/**
 * Read git status (porcelain format) with line limit.
 */
function readGitStatus(cwd: string, maxLines: number): string[] | null {
	const result = spawnSync("git", ["-C", cwd, "status", "--porcelain"], {
		encoding: "utf8",
		timeout: 2000,
	});
	if (result.status !== 0) return null;

	const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) return null;

	// Limit lines and add truncation marker
	if (lines.length > maxLines) {
		return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more)`];
	}
	return lines;
}

/**
 * Read recent commits (oneline format) with limit.
 */
function readRecentCommits(cwd: string, maxCommits: number): string[] | null {
	const result = spawnSync("git", ["-C", cwd, "log", "--oneline", `-n${maxCommits}`], {
		encoding: "utf8",
		timeout: 2000,
	});
	if (result.status !== 0) return null;

	const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
	return lines.length > 0 ? lines : null;
}

/**
 * Read folder structure recursively with depth and entry limits.
 * Returns indented lines showing the tree structure.
 */
function readFolderStructure(cwd: string, maxDepth: number, maxEntriesPerDir: number): string[] {
	const structure: string[] = [];

	function traverse(dir: string, depth: number, prefix: string): void {
		if (depth > maxDepth) return;

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		// Filter out dotfiles and common noise directories
		const filtered = entries
			.filter((entry) => !entry.startsWith("."))
			.filter((entry) => !["node_modules", "dist", "build", "target", "__pycache__"].includes(entry))
			.sort((a, b) => a.localeCompare(b));

		const limited = filtered.slice(0, maxEntriesPerDir);
		const omitted = filtered.length - limited.length;

		for (const entry of limited) {
			const entryPath = join(dir, entry);
			let isDir = false;
			try {
				isDir = statSync(entryPath).isDirectory();
			} catch {
				continue;
			}

			const line = `${prefix}${entry}${isDir ? "/" : ""}`;
			structure.push(line);

			if (isDir && depth < maxDepth) {
				traverse(entryPath, depth + 1, `${prefix}  `);
			}
		}

		if (omitted > 0) {
			structure.push(`${prefix}... (${omitted} more)`);
		}
	}

	traverse(cwd, 0, "");
	return structure;
}
