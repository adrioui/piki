/**
 * Tests for src/core/snapshot.ts — Git-based auto-snapshot.
 *
 * Uses temporary git repos in /tmp to avoid mutating the piki workspace.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createSnapshot,
	DEFAULT_SNAPSHOT_RETENTION,
	deleteSnapshotsForSession,
	diffSnapshotAgainstWorktree,
	isGitRepo,
	isSafeVcsWorkspace,
	listSnapshots,
	pruneSnapshotRefs,
	restoreSnapshot,
} from "../src/core/snapshot.ts";

/** Create a minimal git repo at a temp location and return the path. */
function createTempGitRepo(): string {
	const dir = mkdtempSync(join(process.env.HOME ?? tmpdir(), "piki-snapshot-test-"));
	mkdirSync(join(dir, "subdir"), { recursive: true });

	// Init git
	execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });

	// First commit
	writeFileSync(join(dir, "readme.md"), "# Test Repo\n");
	execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: dir, stdio: "pipe" });

	return dir;
}

describe("isGitRepo", () => {
	it("returns true for the piki repo itself", () => {
		// The piki monorepo root
		const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: __dirname,
			stdio: "pipe",
			encoding: "utf-8",
		}).trim();
		expect(isGitRepo(repoRoot)).toBe(true);
	});

	it("returns false for a non-git directory", () => {
		expect(isGitRepo("/tmp")).toBe(false);
	});
});

describe("isSafeVcsWorkspace", () => {
	it("requires the workspace to be below HOME", () => {
		const originalHome = process.env.HOME;
		const home = mkdtempSync(join(tmpdir(), "piki-home-"));
		const outside = mkdtempSync(join(tmpdir(), "piki-outside-longer-than-home-"));
		try {
			process.env.HOME = home;
			expect(isSafeVcsWorkspace(home)).toBe(false);
			expect(isSafeVcsWorkspace(join(home, "project"))).toBe(true);
			expect(isSafeVcsWorkspace(outside)).toBe(false);
		} finally {
			process.env.HOME = originalHome;
			rmSync(home, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("createSnapshot", () => {
	let repoDir: string;

	beforeAll(() => {
		repoDir = createTempGitRepo();
	});

	afterAll(() => {
		rmSync(repoDir, { recursive: true, force: true });
	});

	it("returns a non-null tree OID string", () => {
		const oid = createSnapshot(repoDir, "test-session", "test-msg-1");
		expect(oid).toBeTruthy();
		expect(typeof oid).toBe("string");
		expect(oid!.length).toBeGreaterThan(0);
	});

	it("returns null for a non-git directory", () => {
		const result = createSnapshot("/tmp", "test-session", "no-git");
		expect(result).toBeNull();
	});
});

describe("restoreSnapshot", () => {
	let repoDir: string;
	let originalContent: string;

	beforeAll(() => {
		repoDir = createTempGitRepo();
		originalContent = "hello world\n";
		writeFileSync(join(repoDir, "file.txt"), originalContent);
		execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "Add file.txt"], { cwd: repoDir, stdio: "pipe" });
	});

	afterAll(() => {
		rmSync(repoDir, { recursive: true, force: true });
	});

	it("restores a file after modification", () => {
		// Snapshot current state
		const oid = createSnapshot(repoDir, "restore-test", "snap-1");
		expect(oid).toBeTruthy();

		// Modify the file
		writeFileSync(join(repoDir, "file.txt"), "modified content\n");

		// Verify it changed
		expect(readFileSync(join(repoDir, "file.txt"), "utf-8")).toBe("modified content\n");

		// Restore from snapshot
		restoreSnapshot(repoDir, oid!);

		// Verify it's restored
		expect(readFileSync(join(repoDir, "file.txt"), "utf-8")).toBe(originalContent);
	});

	it("restores deleted files from snapshot", () => {
		// Create a new file, snapshot, delete it, restore
		writeFileSync(join(repoDir, "new-file.txt"), "temporary\n");
		execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "Add new-file.txt"], { cwd: repoDir, stdio: "pipe" });

		const oid = createSnapshot(repoDir, "restore-test", "snap-2");
		expect(oid).toBeTruthy();

		// Delete the file
		rmSync(join(repoDir, "new-file.txt"));
		expect(() => readFileSync(join(repoDir, "new-file.txt"), "utf-8")).toThrow();

		// Restore
		restoreSnapshot(repoDir, oid!);
		expect(readFileSync(join(repoDir, "new-file.txt"), "utf-8")).toBe("temporary\n");
	});

	it("removes untracked files created after snapshot", () => {
		const oid = createSnapshot(repoDir, "restore-test", "snap-untracked-clean");
		expect(oid).toBeTruthy();

		writeFileSync(join(repoDir, "created-after-snapshot.txt"), "untracked\n");

		restoreSnapshot(repoDir, oid!);

		expect(() => readFileSync(join(repoDir, "created-after-snapshot.txt"), "utf-8")).toThrow();
	});

	it("can restore a specific path", () => {
		mkdirSync(join(repoDir, "subdir"), { recursive: true });
		writeFileSync(join(repoDir, "subdir/other.txt"), "nested content\n");
		execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "Add nested"], { cwd: repoDir, stdio: "pipe" });

		const oid = createSnapshot(repoDir, "restore-test", "snap-3");
		expect(oid).toBeTruthy();

		// Modify the nested file
		writeFileSync(join(repoDir, "subdir/other.txt"), "modified nested\n");

		// Only restore that path
		restoreSnapshot(repoDir, oid!, "subdir/other.txt");

		expect(readFileSync(join(repoDir, "subdir/other.txt"), "utf-8")).toBe("nested content\n");
	});
});

describe("listSnapshots", () => {
	let repoDir: string;

	beforeAll(() => {
		repoDir = createTempGitRepo();
	});

	afterAll(() => {
		rmSync(repoDir, { recursive: true, force: true });
	});

	it("returns an empty array when no snapshots exist", () => {
		const entries = listSnapshots(repoDir, "no-snapshots-yet");
		expect(Array.isArray(entries)).toBe(true);
		expect(entries.length).toBe(0);
	});

	it("returns entries after createSnapshot is called", () => {
		const oid1 = createSnapshot(repoDir, "list-test", "snap-a");
		expect(oid1).toBeTruthy();
		const oid2 = createSnapshot(repoDir, "list-test", "snap-b");
		expect(oid2).toBeTruthy();

		const entries = listSnapshots(repoDir, "list-test");
		expect(entries.length).toBe(2);

		// Check entry shape
		const snapA = entries.find((e) => e.messageId === "snap-a");
		expect(snapA).toBeDefined();
		expect(snapA!.treeOID).toBe(oid1);
		expect(typeof snapA!.timestamp).toBe("number");

		const snapB = entries.find((e) => e.messageId === "snap-b");
		expect(snapB).toBeDefined();
		expect(snapB!.treeOID).toBe(oid2);
	});

	it("returns entries with valid timestamps sorted ascending", () => {
		const entries = listSnapshots(repoDir, "list-test");
		expect(entries.length).toBeGreaterThanOrEqual(2);

		for (const entry of entries) {
			expect(Number.isFinite(entry.timestamp)).toBe(true);
		}

		for (let i = 1; i < entries.length; i++) {
			expect(entries[i].timestamp).toBeGreaterThanOrEqual(entries[i - 1].timestamp);
		}
	});

	it("returns empty for a different session ID", () => {
		const entries = listSnapshots(repoDir, "other-session");
		expect(entries.length).toBe(0);
	});
});

describe("diffSnapshotAgainstWorktree", () => {
	let repoDir: string;

	beforeAll(() => {
		repoDir = createTempGitRepo();
	});

	afterAll(() => {
		rmSync(repoDir, { recursive: true, force: true });
	});

	it("includes untracked files in changedFiles", () => {
		const oid = createSnapshot(repoDir, "diff-test", "snap-1");
		expect(oid).toBeTruthy();

		// Create an untracked file (not staged)
		writeFileSync(join(repoDir, "untracked.txt"), "new content\n");

		const result = diffSnapshotAgainstWorktree(repoDir, oid!);
		expect(result.changedFiles).toContain("untracked.txt");

		// Clean up
		rmSync(join(repoDir, "untracked.txt"));
	});

	it("includes both tracked and untracked changes", () => {
		// Modify a tracked file
		writeFileSync(join(repoDir, "readme.md"), "# Modified\n");
		const oid = createSnapshot(repoDir, "diff-test", "snap-2");
		expect(oid).toBeTruthy();

		// Change tracked file and add untracked
		writeFileSync(join(repoDir, "readme.md"), "# Changed again\n");
		writeFileSync(join(repoDir, "new-file.txt"), "brand new\n");

		const result = diffSnapshotAgainstWorktree(repoDir, oid!);
		expect(result.changedFiles).toContain("readme.md");
		expect(result.changedFiles).toContain("new-file.txt");
	});
});

describe("createSnapshot retention pruning", () => {
	let repoDir: string;

	beforeAll(() => {
		repoDir = createTempGitRepo();
	});

	afterAll(() => {
		rmSync(repoDir, { recursive: true, force: true });
	});

	it("auto-prunes oldest refs when exceeding retention", () => {
		const sessionId = "retention-test";
		// Create 5 snapshots with retention 2; only the newest 2 should remain.
		for (let i = 0; i < 5; i++) {
			const oid = createSnapshot(repoDir, sessionId, `snap-${i}`, 2);
			expect(oid).toBeTruthy();
		}

		const entries = listSnapshots(repoDir, sessionId);
		expect(entries.length).toBe(2);
		const messageIds = entries.map((e) => e.messageId);
		expect(messageIds).toContain("snap-3");
		expect(messageIds).toContain("snap-4");
		expect(messageIds).not.toContain("snap-0");
		expect(messageIds).not.toContain("snap-1");
	});

	it("keeps the freshly written redo ref during pruning", () => {
		const sessionId = "retention-redo-test";
		createSnapshot(repoDir, sessionId, "snap-0", 1);
		const redoOid = createSnapshot(repoDir, sessionId, "redo-snap", 1);
		const entries = listSnapshots(repoDir, sessionId);
		expect(entries.length).toBe(1);
		expect(entries[0]!.messageId).toBe("redo-snap");
		expect(entries[0]!.treeOID).toBe(redoOid);
	});
});

describe("pruneSnapshotRefs", () => {
	let repoDir: string;

	beforeAll(() => {
		repoDir = createTempGitRepo();
	});

	afterAll(() => {
		rmSync(repoDir, { recursive: true, force: true });
	});

	it("removes the oldest refs and keeps the newest", () => {
		const sessionId = "prune-test";
		for (let i = 0; i < 5; i++) {
			const oid = createSnapshot(repoDir, sessionId, `snap-${i}`);
			expect(oid).toBeTruthy();
		}
		expect(listSnapshots(repoDir, sessionId).length).toBe(5);

		pruneSnapshotRefs(repoDir, sessionId, 3);

		const entries = listSnapshots(repoDir, sessionId);
		expect(entries.length).toBe(3);
		const messageIds = entries.map((e) => e.messageId);
		expect(messageIds).toEqual(["snap-2", "snap-3", "snap-4"]);
	});

	it("is a no-op when under the retention limit", () => {
		const sessionId = "prune-under-test";
		for (let i = 0; i < 2; i++) {
			const oid = createSnapshot(repoDir, sessionId, `snap-${i}`);
			expect(oid).toBeTruthy();
		}
		pruneSnapshotRefs(repoDir, sessionId, DEFAULT_SNAPSHOT_RETENTION);
		expect(listSnapshots(repoDir, sessionId).length).toBe(2);
	});
});

describe("deleteSnapshotsForSession", () => {
	let repoDir: string;

	beforeAll(() => {
		repoDir = createTempGitRepo();
	});

	afterAll(() => {
		rmSync(repoDir, { recursive: true, force: true });
	});

	it("removes the session namespace directory and all refs", () => {
		const sessionId = "delete-test";
		createSnapshot(repoDir, sessionId, "snap-0");
		createSnapshot(repoDir, sessionId, "snap-1");
		expect(listSnapshots(repoDir, sessionId).length).toBe(2);

		deleteSnapshotsForSession(repoDir, sessionId);

		expect(listSnapshots(repoDir, sessionId).length).toBe(0);
		const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: repoDir,
			stdio: "pipe",
			encoding: "utf-8",
		}).trim();
		const nsDir = join(repoDir, gitDir, "refs", "piki", "snapshots", sessionId);
		expect(existsSync(nsDir)).toBe(false);
	});

	it("is a no-op for an unknown session id", () => {
		expect(() => deleteSnapshotsForSession(repoDir, "does-not-exist")).not.toThrow();
		expect(listSnapshots(repoDir, "does-not-exist").length).toBe(0);
	});
});
