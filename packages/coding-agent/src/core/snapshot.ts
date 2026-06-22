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
 * Uses `git checkout --no-overlay <treeOID> -- <path ?? ".">` to reset
 * files, including deleting files not present in the snapshot.
 */
export function restoreSnapshot(workspaceRoot: string, treeOID: string, path?: string): void {
	const checkoutPath = path || ".";
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
