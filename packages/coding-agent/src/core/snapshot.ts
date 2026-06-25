/**
 * Auto-snapshot: Git-based undo using tree snapshots.
 *
 * Creates lightweight git tree snapshots of the working directory before
 * each agent turn. Snapshots are stored as git refs under refs/pi/snapshots/
 * and can be restored to undo file changes.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

/**
 * Create a git tree snapshot of the working directory.
 *
 * 1. Creates a temp index file.
 * 2. Loads HEAD into the temp index (or --empty if no HEAD).
 * 3. Runs `git add -A` against the temp index.
 * 4. Writes the tree and stores its OID under refs/pi/snapshots/<sessionId>/<messageId>.
 * 5. Cleans up the temp index.
 *
 * Returns the tree OID, or null if not a git repo or the git commands fail.
 */
export function createSnapshot(workspaceRoot: string, sessionId: string, messageId: string): string | null {
	if (!isGitRepo(workspaceRoot)) {
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
		const ref = `refs/pi/snapshots/${sessionId}/${messageId}`;
		execFileSync("git", ["update-ref", ref, treeOID], {
			cwd: workspaceRoot,
			stdio: "pipe",
		});

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
 * Restore the working tree to a previous snapshot.
 *
 * 1. Cleans untracked files not present in the snapshot.
 * 2. Uses `git checkout --no-overlay <treeOID> -- <path ?? ".">` to reset tracked changes.
 */
export function restoreSnapshot(workspaceRoot: string, treeOID: string, path?: string): void {
	const checkoutPath = path || ".";
	// Remove untracked files not in the snapshot, except .git and pi internal dirs
	try {
		execFileSync(
			"git",
			["clean", "-fd", "-e", ".git", "-e", ".pi", checkoutPath === "." ? "" : checkoutPath].filter(Boolean),
			{ cwd: workspaceRoot, stdio: "pipe" },
		);
	} catch {
		// Ignore clean errors; checkout will still overwrite tracked files
	}
	execFileSync("git", ["checkout", "--no-overlay", treeOID, "--", checkoutPath], {
		cwd: workspaceRoot,
		stdio: "pipe",
	});
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
): Array<{ messageId: string; treeOID: string; timestamp: number }> {
	try {
		const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: workspaceRoot,
			stdio: "pipe",
			encoding: "utf-8",
		}).trim();

		const refsDir = resolve(workspaceRoot, gitDir, "refs", "pi", "snapshots", sessionId);

		if (!existsSync(refsDir)) {
			return [];
		}

		const entries: Array<{ messageId: string; treeOID: string; timestamp: number }> = [];

		for (const file of readdirSync(refsDir)) {
			const filePath = join(refsDir, file);
			const content = readFileSync(filePath, "utf-8").trim();
			const stat = statSync(filePath);
			entries.push({
				messageId: file,
				treeOID: content,
				timestamp: stat.mtimeMs,
			});
		}

		return entries.sort((a, b) => a.timestamp - b.timestamp);
	} catch {
		return [];
	}
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
