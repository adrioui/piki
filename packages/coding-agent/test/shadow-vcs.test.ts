import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommitInfo, DiffFile } from "@piki/vcs";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createSnapshot } from "../src/core/snapshot.ts";
import { createCheckpointChangesToolDefinition } from "../src/core/tools/checkpoint-changes.ts";
import { createCheckpointRollbackToolDefinition } from "../src/core/tools/checkpoint-rollback.ts";
import { makeShadowVcsLayer, ShadowVcsTag } from "../src/core/vcs/shadow-vcs.ts";

const tempDirs: string[] = [];

function makeRepo(): string {
	// The snapshot-based rollback tool requires the workspace to live inside the
	// user's home directory (isSafeVcsWorkspace guard), so create it there
	// rather than under the shared /tmp.
	const dir = mkdtempSync(join(homedir(), ".piki-shadow-vcs-"));
	tempDirs.push(dir);
	execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "tracked.txt"), "base\n", "utf8");
	execFileSync("git", ["add", "tracked.txt"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "pipe" });
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("ShadowVcs", () => {
	it("records, diffs, checkpoints, reads, restores, undoes, and redoes worktree state", async () => {
		const repo = makeRepo();
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(makeShadowVcsLayer({ backend: undefined, worktreePath: repo })),
		);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const vcs = yield* ShadowVcsTag;

					const firstOperation = yield* vcs.record({ message: "first record" });
					writeFileSync(join(repo, "tracked.txt"), "changed\n", "utf8");
					writeFileSync(join(repo, "new.txt"), "new\nline\n", "utf8");

					const workingDiff = yield* vcs.diffWorking({ against: firstOperation });
					const checkpoint = yield* vcs.checkpoint({ name: "after-change", message: "after change" });
					const atCheckpoint = yield* vcs.readAt({ path: "tracked.txt", at: "after-change" });
					const rangedCheckpoints = yield* vcs.listCheckpoints({ from: firstOperation, to: "after-change" });

					yield* vcs.restore({ to: firstOperation });
					const restored = readFileSync(join(repo, "tracked.txt"), "utf8");
					const newExistsAfterRestore = existsSync(join(repo, "new.txt"));

					yield* vcs.redo;
					const redone = readFileSync(join(repo, "tracked.txt"), "utf8");

					yield* vcs.undo;
					const undone = readFileSync(join(repo, "tracked.txt"), "utf8");

					return {
						firstOperation,
						workingDiff,
						checkpoint,
						rangedCheckpoints,
						atCheckpoint: atCheckpoint?.toString("utf8"),
						restored,
						newExistsAfterRestore,
						redone,
						undone,
						checkpoints: yield* vcs.listNamedCheckpoints,
						head: yield* vcs.head,
					};
				}),
			);

			expect(result.firstOperation).toMatch(/^\d+-/);
			expect(result.workingDiff.files.map((file: DiffFile) => file.path).sort()).toEqual(["new.txt", "tracked.txt"]);
			expect(result.workingDiff.additions).toBeGreaterThanOrEqual(2);
			expect(result.checkpoint.name).toBe("after-change");
			expect(result.rangedCheckpoints.map((checkpoint: CommitInfo) => checkpoint.name)).toEqual(["after-change"]);
			expect(result.atCheckpoint).toBe("changed\n");
			expect(result.restored).toBe("base\n");
			expect(result.newExistsAfterRestore).toBe(false);
			expect(result.redone).toBe("changed\n");
			expect(result.undone).toBe("base\n");
			expect(result.checkpoints.map((checkpoint: CommitInfo) => checkpoint.name)).toEqual(["after-change"]);
			expect(result.head.commitHash).toMatch(/^[a-f0-9]{40}$/);
		} finally {
			await runtime.dispose();
		}
	});

	it("uses ShadowVcs in checkpoint tools with scoped rollback", async () => {
		const repo = makeRepo();
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(makeShadowVcsLayer({ backend: undefined, worktreePath: repo })),
		);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const vcs = yield* ShadowVcsTag;
					yield* vcs.record({ message: "baseline" });
					// Capture a snapshot at the baseline so the rollback tool can
					// address it by message id (the WIP snapshot-selector API no
					// longer accepts git refs like "head").
					createSnapshot(repo, "session-1", "baseline");
					writeFileSync(join(repo, "tracked.txt"), "tool changed\n", "utf8");
					writeFileSync(join(repo, "other.txt"), "keep\n", "utf8");

					const changes = createCheckpointChangesToolDefinition(repo, "session-1");
					const rollback = createCheckpointRollbackToolDefinition(repo, "session-1", vcs);
					const changesResult = yield* Effect.promise(() =>
						changes.execute("changes-1", { since: "baseline", glob: "tracked.txt" }, undefined, undefined, {
							sessionManager: { getSessionId: () => "session-1" },
						} as never),
					);
					const rollbackResult = yield* Effect.promise(() =>
						rollback.execute("rollback-1", { since: "baseline", glob: "tracked.txt" }, undefined, undefined, {
							sessionManager: { getSessionId: () => "session-1" },
						} as never),
					);

					return { changesResult, rollbackResult };
				}),
			);

			expect(result.changesResult.content[0]?.type).toBe("text");
			expect(result.rollbackResult.content[0]?.type).toBe("text");
			expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("base\n");
			expect(readFileSync(join(repo, "other.txt"), "utf8")).toBe("keep\n");
		} finally {
			await runtime.dispose();
		}
	});
});
