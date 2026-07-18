/**
 * Centralized git state collection for the coding agent.
 *
 * Provides a single source of truth for reading the current git branch,
 * working-tree status, and recent commits. Status is collected via
 * `git status --porcelain=v2` (porcelain v2) and parsed by `parsePorcelainV2`,
 * matching Magnitude alpha22's structured git reporting.
 *
 * All reads are read-only and failure-tolerant: any command failure yields a
 * partial result rather than throwing. This module is intentionally decoupled
 * from the (orphaned) `@piki/vcs` Effect stack and uses plain `spawnSync`.
 */

import { spawnSync } from "node:child_process";

import { isGitRepo } from "./snapshot.ts";

/** A single porcelain v2 status entry. */
export interface GitFileStatus {
	/** Index (staged) status code, one of: M A D R C U T X (or "."). */
	x: string;
	/** Worktree (unstaged) status code, one of: M A D R C U T X (or "."). */
	y: string;
	/** Current path (relative to repo root). */
	path: string;
	/** Original path for renames/copies (present when `y === "R"` or `y === "C"`). */
	oldPath?: string;
}

/** Structured snapshot of the current git state. */
export interface GitState {
	/** Current branch name, or null when detached / unavailable. */
	branch: string | null;
	/** Parsed porcelain v2 entries (staged, modified, untracked, etc.). */
	status: GitFileStatus[];
	/** Most recent commit subjects (oneline), newest first. */
	recentCommits: string[];
}

/**
 * Parse the output of `git status --porcelain=v2` into structured entries.
 *
 * Spec (per git docs):
 *  1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *  2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
 *  u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 *  ? <path>        (untracked)
 *  ! <path>        (ignored)
 *
 * Malformed lines are skipped rather than throwing. Path/origPath are tab
 * separated.
 */
export function parsePorcelainV2(raw: string): GitFileStatus[] {
	const entries: GitFileStatus[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		const tag = line[0];
		if (tag === "1" || tag === "u") {
			// 1: fields; u: fields with an extra m3/h3. For status codes we only
			// need the first token (XY) and the final path field. Split once.
			const parts = line.split("\t");
			const head = parts[0]!.split(" ");
			if (head.length < 2) continue;
			const xy = head[1]!;
			if (xy.length < 2) continue;
			const path = parts.length > 1 ? parts[1]! : head[head.length - 1]!;
			entries.push({ x: xy[0]!, y: xy[1]!, path });
		} else if (tag === "2") {
			const parts = line.split("\t");
			if (parts.length < 2) continue;
			const head = parts[0]!.split(" ");
			if (head.length < 2) continue;
			const xy = head[1]!;
			if (xy.length < 2) continue;
			// head layout: 2 XY sub mH mI mW hH hI X<score> <path>
			// origPath follows a tab after the head.
			const path = head[head.length - 1]!;
			const origPath = parts[1]!;
			entries.push({ x: xy[0]!, y: xy[1]!, path, oldPath: origPath });
		} else if (tag === "?" || tag === "!") {
			const path = line.slice(2);
			if (!path) continue;
			entries.push({ x: tag, y: tag, path });
		}
		// Unknown tags are skipped (defensive).
	}
	return entries;
}

function git(cwd: string, args: string[], timeoutMs = 2000): string | undefined {
	try {
		const result = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			timeout: timeoutMs,
		});
		if (result.status !== 0) return undefined;
		return result.stdout;
	} catch {
		return undefined;
	}
}

/**
 * Collect the current git branch, status, and recent commits.
 *
 * Returns `undefined` when `cwd` is not inside a git work tree. Never throws.
 */
export function collectGitState(cwd: string): GitState | undefined {
	if (!isGitRepo(cwd)) return undefined;

	let branch: string | null = null;
	const branchOut = git(cwd, ["branch", "--show-current"]);
	if (branchOut && branchOut.trim().length > 0) {
		branch = branchOut.trim();
	} else {
		// Detached HEAD: fall back to short commit id.
		const headOut = git(cwd, ["rev-parse", "--short", "HEAD"]);
		branch = headOut ? `(detached ${headOut.trim()})` : null;
	}

	const statusRaw = git(cwd, ["status", "--porcelain=v2"]);
	const status = statusRaw ? parsePorcelainV2(statusRaw) : [];

	const logRaw = git(cwd, ["log", "--oneline", "-10"]);
	const recentCommits = logRaw
		? logRaw
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
		: [];

	return { branch, status, recentCommits };
}
