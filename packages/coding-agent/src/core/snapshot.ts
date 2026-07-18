/**
 * Auto-snapshot: Git-based undo using tree snapshots.
 *
 * Creates lightweight git tree snapshots of the working directory before
 * each agent turn. Snapshots are stored as git refs under refs/piki/snapshots/
 * and can be restored to undo file changes.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Returns true if `dir` is inside a git work tree.
 */
export function isGitRepo(dir: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: dir,
			stdio: "pipe",
			encoding: "utf-8",
		});
		return true;
	} catch {
		return false;
	}
}

export type VcsOperation =
	| "commit"
	| "revert"
	| "cherry-pick"
	| "diff"
	| "log"
	| "status"
	| "branch"
	| "checkout"
	| "switch"
	| "restore"
	| "reset"
	| "stash"
	| "tag"
	| "show"
	| "merge"
	| "rebase"
	| "add"
	| "clean";

export const SUPPORTED_VCS_OPERATIONS: VcsOperation[] = [
	"commit",
	"revert",
	"cherry-pick",
	"diff",
	"log",
	"status",
	"branch",
	"checkout",
	"switch",
	"restore",
	"reset",
	"stash",
	"tag",
	"show",
	"merge",
	"rebase",
	"add",
	"clean",
];

export function isSafeVcsWorkspace(workspaceRoot: string): boolean {
	const resolved = resolve(workspaceRoot);
	const home = resolve(process.env.HOME || homedir());
	const relativePath = relative(home, resolved);
	return (
		resolved !== "/" &&
		resolved !== home &&
		relativePath !== "" &&
		!relativePath.startsWith("..") &&
		!isAbsolute(relativePath)
	);
}

export function shouldEnableGitTracking(workspaceRoot: string): boolean {
	if (!isSafeVcsWorkspace(workspaceRoot) || !isGitRepo(workspaceRoot)) return false;
	try {
		const count = countTrackedFiles(workspaceRoot);
		if (count > 100000) {
			console.warn(`VCS tracking disabled for large repo (${count} files > 100000 threshold)`);
			return false;
		}
		if (count > 50000) {
			console.warn(`VCS tracking enabled with warning for large repo (${count} files)`);
		}
		return true;
	} catch {
		return false;
	}
}

function countTrackedFiles(workspaceRoot: string): number {
	try {
		const output = execFileSync("git", ["ls-files", "--count"], {
			cwd: workspaceRoot,
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
		const count = Number.parseInt(output, 10);
		if (Number.isFinite(count)) return count;
	} catch {
		// Fall back for older Git versions.
	}
	const output = execFileSync("git", ["ls-files"], {
		cwd: workspaceRoot,
		encoding: "utf-8",
		stdio: "pipe",
		maxBuffer: 10 * 1024 * 1024,
	});
	return output.trim().split("\n").filter(Boolean).length;
}

/**
 * Create a git tree snapshot of the working directory.
 *
 * 1. Creates a temp index file.
 * 2. Loads HEAD into the temp index (or --empty if no HEAD).
 * 3. Runs `git add -A` against the temp index.
 * 4. Writes the tree and stores its OID under refs/piki/snapshots/<sessionId>/<messageId>.
 * 5. Cleans up the temp index.
 *
 * Returns the tree OID, or null if not a git repo or the git commands fail.
 */
export function createSnapshot(
	workspaceRoot: string,
	sessionId: string,
	messageId: string,
	retention = DEFAULT_SNAPSHOT_RETENTION,
): string | null {
	if (!shouldEnableGitTracking(workspaceRoot)) {
		return null;
	}
	if (!isSafeRefSegment(sessionId) || !isSafeRefSegment(messageId)) {
		return null;
	}

	const tmpIndex = mkdtempSync(join(tmpdir(), "pi-snapshot-"));
	const indexFile = join(tmpIndex, "index");

	try {
		// Determine whether there is a HEAD commit
		let hasHead = false;
		try {
			execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
				cwd: workspaceRoot,
				stdio: "pipe",
				encoding: "utf-8",
			});
			hasHead = true;
		} catch {
			// No HEAD yet — empty repository
		}

		const env = { ...process.env, GIT_INDEX_FILE: indexFile };

		// Load current HEAD (or empty) into temp index
		if (hasHead) {
			execFileSync("git", ["read-tree", "HEAD"], {
				cwd: workspaceRoot,
				stdio: "pipe",
				env,
			});
		} else {
			execFileSync("git", ["read-tree", "--empty"], {
				cwd: workspaceRoot,
				stdio: "pipe",
				env,
			});
		}

		// Stage all working-tree changes into the temp index
		execFileSync("git", ["add", "-A"], {
			cwd: workspaceRoot,
			stdio: "pipe",
			env,
		});

		// Write the tree object from the temp index
		const treeResult = execFileSync("git", ["write-tree"], {
			cwd: workspaceRoot,
			stdio: "pipe",
			encoding: "utf-8",
			env,
		});
		const treeOID = treeResult.trim();
		if (!treeOID) {
			return null;
		}

		// Store the tree OID as a ref
		const ref = `refs/piki/snapshots/${sessionId}/${messageId}`;
		execFileSync("git", ["update-ref", ref, treeOID], {
			cwd: workspaceRoot,
			stdio: "pipe",
		});

		// Bound retention: prune oldest refs for this session (best-effort)
		pruneSnapshotRefs(workspaceRoot, sessionId, retention);

		return treeOID;
	} catch {
		return null;
	} finally {
		// Clean up temp index directory
		try {
			rmSync(tmpIndex, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Default number of snapshot refs retained per session. Older refs are pruned
 * after each new snapshot is written. Configurable via
 * `ExperimentalSettings.snapshotRetention`.
 */
export const DEFAULT_SNAPSHOT_RETENTION = 50;

/**
 * Path to the git ref directory that stores snapshots for a session:
 * `<gitDir>/refs/piki/snapshots/<sessionId>`. Returns null if the git dir
 * cannot be resolved. Caller must have validated `sessionId` with
 * `isSafeRefSegment` before using this path.
 */
function snapshotRefsDir(workspaceRoot: string, sessionId: string): string | null {
	try {
		const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: workspaceRoot,
			stdio: "pipe",
			encoding: "utf-8",
		}).trim();
		return resolve(workspaceRoot, gitDir, "refs", "piki", "snapshots", sessionId);
	} catch {
		return null;
	}
}

/**
 * Remove all snapshot refs for a session. Best-effort and idempotent: safe to
 * call when no refs exist (e.g. snapshots disabled) or when there is no git
 * dir. Never throws.
 */
export function deleteSnapshotsForSession(workspaceRoot: string, sessionId: string): void {
	if (!isSafeRefSegment(sessionId)) return;
	const dir = snapshotRefsDir(workspaceRoot, sessionId);
	if (!dir) return;
	try {
		if (existsSync(dir)) {
			for (const file of readdirSync(dir)) {
				try {
					rmSync(join(dir, file), { force: true });
				} catch {
					// Ignore per-file removal errors
				}
			}
			rmSync(dir, { recursive: true, force: true });
		}
	} catch {
		// Ignore; deletion is best-effort
	}
}

/**
 * Prune snapshot refs for a session down to `keepN`, deleting the oldest refs
 * first (mtime ascending). Keeps the newest `keepN` so `latest`/`previous`/
 * HH:MM:SS addressing remain valid. Best-effort and idempotent.
 */
export function pruneSnapshotRefs(workspaceRoot: string, sessionId: string, keepN: number): void {
	if (!isSafeRefSegment(sessionId)) return;
	if (!Number.isFinite(keepN) || keepN < 0) return;
	const dir = snapshotRefsDir(workspaceRoot, sessionId);
	if (!dir) return;
	try {
		if (!existsSync(dir)) return;
		const entries = readdirSync(dir)
			.map((file) => {
				const filePath = join(dir, file);
				let timestamp = 0;
				try {
					timestamp = statSync(filePath).mtimeMs;
				} catch {
					timestamp = 0;
				}
				return { file, timestamp };
			})
			.sort((a, b) => a.timestamp - b.timestamp);

		const excess = entries.length - keepN;
		if (excess <= 0) return;

		for (let i = 0; i < excess; i++) {
			try {
				rmSync(join(dir, entries[i]!.file), { force: true });
			} catch {
				// Ignore per-file removal errors
			}
		}

		// Remove the now-empty namespace dir if no refs remain
		const remaining = readdirSync(dir);
		if (remaining.length === 0) {
			rmSync(dir, { recursive: true, force: true });
		}
	} catch {
		// Ignore; pruning is best-effort
	}
}

export function createCheckpointId(kind: "turn-start" | "turn-end" | "manual" | "redo"): string {
	return `${Date.now()}-${kind}-${cryptoRandomSuffix()}`;
}

function cryptoRandomSuffix(): string {
	return randomUUID().slice(0, 8);
}

/**
 * Restore the working tree to a previous snapshot.
 *
 * 1. Cleans untracked files not present in the snapshot.
 * 2. Uses `git checkout --no-overlay <treeOID> -- <path ?? ".">` to reset tracked changes.
 */
export function restoreSnapshot(workspaceRoot: string, treeOID: string, path?: string): void {
	if (!isValidTreeOid(workspaceRoot, treeOID)) {
		throw new Error("Invalid snapshot tree object");
	}
	const checkoutPath = normalizeRestorePath(path);
	const cleanArgs = ["clean", "-fd", "-e", ".piki"];
	if (checkoutPath !== ".") {
		cleanArgs.push("--", checkoutPath);
	}
	execFileSync("git", cleanArgs, {
		cwd: workspaceRoot,
		stdio: "pipe",
	});
	execFileSync("git", ["checkout", "--no-overlay", treeOID, "--", checkoutPath], {
		cwd: workspaceRoot,
		stdio: "pipe",
	});
}

function normalizeRestorePath(path: string | undefined): string {
	if (!path) return ".";
	if (path === "." || path === "./") return ".";
	if (isAbsolute(path) || path.includes("..") || path.startsWith(":(") || path.trim() === "") {
		throw new Error(`Unsafe restore path: ${path}`);
	}
	return path;
}

function isSafeRefSegment(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith(".") && !value.endsWith(".lock");
}

function isValidTreeOid(workspaceRoot: string, treeOID: string): boolean {
	if (!/^[a-f0-9]{40,64}$/i.test(treeOID)) return false;
	try {
		const type = execFileSync("git", ["cat-file", "-t", treeOID], {
			cwd: workspaceRoot,
			stdio: "pipe",
			encoding: "utf-8",
		}).trim();
		return type === "tree";
	} catch {
		return false;
	}
}

/**
 * List available snapshots for a session.
 *
 * Returns entries with messageId, treeOID, and timestamp (from ref file
 * mtime), sorted by timestamp ascending (oldest first).
 *
 * Reads ref files directly from the filesystem rather than using
 * git for-each-ref, because git's %(creatordate) is only populated for
 * commit/tag objects, not for lightweight refs pointing to tree objects.
 */
export function listSnapshots(
	workspaceRoot: string,
	sessionId: string,
): Array<{ messageId: string; treeOID: string; timestamp: number; index: number }> {
	if (!isSafeRefSegment(sessionId)) return [];
	try {
		const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: workspaceRoot,
			stdio: "pipe",
			encoding: "utf-8",
		}).trim();

		const refsDir = resolve(workspaceRoot, gitDir, "refs", "piki", "snapshots", sessionId);

		if (!existsSync(refsDir)) {
			return [];
		}

		const entries: Array<{ messageId: string; treeOID: string; timestamp: number; index: number }> = [];

		for (const file of readdirSync(refsDir)) {
			const filePath = join(refsDir, file);
			const content = readFileSync(filePath, "utf-8").trim();
			const stat = statSync(filePath);
			entries.push({
				messageId: file,
				treeOID: content,
				timestamp: stat.mtimeMs,
				index: 0,
			});
		}

		return entries.sort((a, b) => a.timestamp - b.timestamp).map((entry, index) => ({ ...entry, index }));
	} catch {
		return [];
	}
}

export function resolveSnapshotSelector(
	workspaceRoot: string,
	sessionId: string,
	selector: string | undefined,
): { messageId: string; treeOID: string; timestamp: number; index: number } | undefined {
	const snapshots = listSnapshots(workspaceRoot, sessionId);
	if (snapshots.length === 0) return undefined;
	const value = selector?.trim() || "latest";
	if (value === "latest" || value === "last") return snapshots[snapshots.length - 1];
	if (value === "previous" || value === "prev") return snapshots[snapshots.length - 2] ?? snapshots[0];

	const numeric = Number.parseInt(value, 10);
	if (Number.isInteger(numeric) && String(numeric) === value) {
		return snapshots[numeric];
	}

	// HH:MM:SS (or YYYY-MM-DD HH:MM:SS) turn-boundary addressing, matching
	// Magnitude alpha22's checkpoint_rollback/checkpoint_changes `since` param.
	// Resolves to the latest snapshot whose mtime is at or before that time.
	if (isBoundaryTimestamp(value)) {
		const target = parseBoundaryTimestamp(value);
		if (target !== null) {
			let candidate: (typeof snapshots)[number] | undefined;
			for (const snapshot of snapshots) {
				if (snapshot.timestamp <= target) {
					candidate = snapshot;
				}
			}
			return candidate ?? snapshots[0];
		}
	}

	const date = new Date(value);
	if (!Number.isNaN(date.getTime())) {
		let candidate: (typeof snapshots)[number] | undefined;
		for (const snapshot of snapshots) {
			if (snapshot.timestamp <= date.getTime()) {
				candidate = snapshot;
			}
		}
		return candidate ?? snapshots[0];
	}

	return snapshots.find((snapshot) => snapshot.messageId === value || snapshot.treeOID === value);
}

const BOUNDARY_TIME_RE = /^(\d{1,2}):(\d{2}):(\d{2})$/;
const BOUNDARY_DAYTIME_RE = /^\d{4}-\d{2}-\d{2} (\d{1,2}):(\d{2}):(\d{2})$/;

/** True if `value` looks like a Magnitude turn-boundary timestamp (`HH:MM:SS` or `YYYY-MM-DD HH:MM:SS`). */
export function isBoundaryTimestamp(value: string): boolean {
	return BOUNDARY_TIME_RE.test(value.trim()) || BOUNDARY_DAYTIME_RE.test(value.trim());
}

/** Parse a turn-boundary timestamp into epoch ms (local time). Returns null if unparseable. */
export function parseBoundaryTimestamp(value: string): number | null {
	const trimmed = value.trim();
	const timeMatch = BOUNDARY_TIME_RE.exec(trimmed) ?? BOUNDARY_DAYTIME_RE.exec(trimmed);
	if (!timeMatch) return null;
	const hours = Number.parseInt(timeMatch[1], 10);
	const minutes = Number.parseInt(timeMatch[2], 10);
	const seconds = Number.parseInt(timeMatch[3], 10);
	if (hours > 23 || minutes > 59 || seconds > 59) return null;
	const now = new Date();
	const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds, 0);
	return candidate.getTime();
}

/**
 * Get the diff between two tree snapshots.
 *
 * Returns a unified diff of files that changed between the two trees.
 * Uses `git diff-tree --no-commit-id -r` to list changed paths, then
 * `git diff --no-index` to produce the actual diff text.
 *
 * If `globPattern` is provided, only files matching the pattern are included.
 */
export function diffSnapshots(
	workspaceRoot: string,
	fromTreeOID: string,
	toTreeOID: string,
	globPattern?: string,
): { changedFiles: string[]; diff: string } {
	try {
		// Get the list of changed files between the two trees
		const changedFilesRaw = execFileSync(
			"git",
			["diff-tree", "--no-commit-id", "-r", "--name-status", fromTreeOID, toTreeOID],
			{
				cwd: workspaceRoot,
				stdio: "pipe",
				encoding: "utf-8",
			},
		).trim();

		if (!changedFilesRaw) {
			return { changedFiles: [], diff: "" };
		}

		const allChangedFiles: string[] = [];
		for (const line of changedFilesRaw.split("\n")) {
			const parts = line.split("\t");
			if (parts.length >= 2) {
				allChangedFiles.push(parts[parts.length - 1]);
			}
		}

		// Filter by glob pattern if provided (simple prefix/suffix matching)
		const changedFiles = globPattern
			? allChangedFiles.filter((f) => matchesSimpleGlob(f, globPattern))
			: allChangedFiles;

		if (changedFiles.length === 0) {
			return { changedFiles: [], diff: "" };
		}

		// Generate diff for changed files using git diff between two tree objects
		const diffArgs = ["diff", "--no-color", fromTreeOID, toTreeOID];
		if (globPattern) {
			// Use pathspec filtering
			diffArgs.push("--", globPattern);
		}

		let diff: string;
		try {
			diff = execFileSync("git", diffArgs, {
				cwd: workspaceRoot,
				stdio: "pipe",
				encoding: "utf-8",
			});
		} catch (err) {
			// git diff exits with code 1 when there are differences
			if (err instanceof Error && "stdout" in err) {
				diff = (err as { stdout: string }).stdout ?? "";
			} else {
				diff = "";
			}
		}

		return { changedFiles, diff };
	} catch {
		return { changedFiles: [], diff: "" };
	}
}

/**
 * Simple glob matching: supports `*` wildcard and exact prefix/suffix.
 * For patterns like `*.ts`, `src/**`, `*.md`.
 */
function matchesSimpleGlob(path: string, pattern: string): boolean {
	if (pattern === "*") return true;
	// Convert glob to regex
	const regex = pattern
		.replace(/\./g, "\\.")
		.replace(/\*\*/g, "<<<GLOBSTAR>>>")
		.replace(/\*/g, "[^/]*")
		.replace(/<<<GLOBSTAR>>>/g, ".*");
	return new RegExp(`^${regex}$`).test(path);
}

/**
 * Diff a snapshot tree against the current working tree.
 *
 * Uses `git diff <treeOID>` which compares the tree object against
 * the current worktree. This is useful for detecting mid-turn changes
 * that haven't been snapshotted yet.
 */
export function diffSnapshotAgainstWorktree(
	workspaceRoot: string,
	fromTreeOID: string,
	globPattern?: string,
): { changedFiles: string[]; diff: string } {
	try {
		// List changed files between tree and worktree
		const listArgs = ["diff", "--name-status", fromTreeOID];
		if (globPattern) {
			listArgs.push("--", globPattern);
		}
		const changedFilesRaw = execFileSync("git", listArgs, {
			cwd: workspaceRoot,
			stdio: "pipe",
			encoding: "utf-8",
		}).trim();

		const changedFiles: string[] = [];
		if (changedFilesRaw) {
			for (const line of changedFilesRaw.split("\n")) {
				const parts = line.split("\t");
				if (parts.length >= 2) {
					changedFiles.push(parts[parts.length - 1]);
				}
			}
		}

		// Also include untracked files not in the snapshot tree. These are
		// files created after the snapshot was taken and won't appear in
		// `git diff <tree>` because git has no prior version to diff against.
		try {
			const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
			if (globPattern) {
				untrackedArgs.push("--", globPattern);
			}
			const untrackedRaw = execFileSync("git", untrackedArgs, {
				cwd: workspaceRoot,
				stdio: "pipe",
				encoding: "utf-8",
			}).trim();
			if (untrackedRaw) {
				for (const file of untrackedRaw.split("\n")) {
					if (file && !changedFiles.includes(file)) {
						changedFiles.push(file);
					}
				}
			}
		} catch {
			// ls-files failure is non-fatal; fall through with tracked changes only
		}

		if (changedFiles.length === 0) {
			return { changedFiles: [], diff: "" };
		}

		// Generate full diff for tracked changes
		const diffArgs = ["diff", "--no-color", fromTreeOID];
		if (globPattern) {
			diffArgs.push("--", globPattern);
		}

		let diff: string;
		try {
			diff = execFileSync("git", diffArgs, {
				cwd: workspaceRoot,
				stdio: "pipe",
				encoding: "utf-8",
			});
		} catch (err) {
			if (err instanceof Error && "stdout" in err) {
				diff = (err as { stdout: string }).stdout ?? "";
			} else {
				diff = "";
			}
		}

		return { changedFiles, diff };
	} catch {
		return { changedFiles: [], diff: "" };
	}
}
