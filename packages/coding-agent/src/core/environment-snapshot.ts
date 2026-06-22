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
	hostname: string | null;
	username: string | null;
	gitBranch: string | null;
	repoUrl: string | null;
	rootListing: string[];
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
	readonly hostname: string | null;
	readonly username: string | null;
	readonly gitBranch: string | null;
	readonly repoUrl: string | null;
	readonly rootListing: readonly string[];
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
	/** Maximum entries in the root listing. Default 20. */
	maxRootListingEntries?: number;
}

/**
 * Default provider: queries the real environment.
 */
export function collectEnvironmentSnapshot(options: CollectEnvironmentSnapshotOptions = {}): EnvironmentSnapshot {
	const cwd = options.cwd ?? process.cwd();
	const date = options.date ?? todayIsoDate();
	const includeUserInfo = options.includeUserInfo ?? true;
	const maxEntries = options.maxRootListingEntries ?? 20;

	const hostname = includeUserInfo ? (options.hostname ?? safeHostname()) : null;
	const username = includeUserInfo ? (options.username ?? safeUsername()) : null;
	const workspaceRoot = findWorkspaceRoot(cwd);

	return {
		date,
		cwd,
		workspaceRoot,
		os: platform(),
		hostname,
		username,
		gitBranch: readGitBranch(cwd),
		repoUrl: readRepoUrl(cwd),
		rootListing: readRootListing(workspaceRoot, maxEntries),
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
	const rootListing = provider.rootListing
		.slice(0, 20)
		.map((entry) => sanitizeField(entry))
		.filter((entry): entry is string => Boolean(entry));

	lines.push("Environment snapshot:");
	lines.push(`- date: ${sanitizeField(provider.date) ?? "(unavailable)"}`);
	lines.push(`- cwd: ${sanitizeField(provider.cwd) ?? "(unavailable)"}`);
	lines.push(`- workspace_root: ${sanitizeField(provider.workspaceRoot) ?? "(unavailable)"}`);
	lines.push(`- os: ${sanitizeField(provider.os) ?? "(unavailable)"}`);
	if (hostname) {
		lines.push(`- hostname: ${hostname}`);
	}
	if (username) {
		lines.push(`- username: ${username}`);
	}
	lines.push(`- git_branch: ${gitBranch ?? "(unavailable)"}`);
	lines.push(`- repo_url: ${repoUrl ?? "(unavailable)"}`);

	if (rootListing.length > 0) {
		lines.push("- root_listing:");
		for (const entry of rootListing) {
			lines.push(`  - ${entry}`);
		}
	} else {
		lines.push("- root_listing: (unavailable)");
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
 * Return the first N entries of `cwd`, sorted, without dotfiles, excluding
 * `.git`. Returns empty array on read failure.
 */
function readRootListing(cwd: string, maxEntries: number): string[] {
	let entries: string[];
	try {
		entries = readdirSync(cwd);
	} catch {
		return [];
	}
	const filtered = entries
		.filter((entry) => !entry.startsWith("."))
		.sort((a, b) => a.localeCompare(b))
		.slice(0, maxEntries)
		.map((entry) => sanitizeField(entry))
		.filter((entry): entry is string => Boolean(entry));
	return filtered;
}
