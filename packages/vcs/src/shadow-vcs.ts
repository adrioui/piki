import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Data, Effect, Layer } from "effect";

export class VcsError extends Data.TaggedError("VcsError")<{
	readonly operation: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export type PointInTime =
	| string
	| { kind: "operation"; id: string }
	| { kind: "checkpoint"; name: string }
	| { kind: "snapshot"; id: string }
	| { kind: "relative"; anchor: PointInTime; offset: number }
	| { kind: "file"; path: string }
	| { kind: "time"; when: Date }
	| { kind: "message"; value: string };

export interface CommitInfo {
	name: string;
	operationId: string;
	commitHash: string;
	treeHash: string;
	timestamp: Date;
	message: string;
	filesChanged: string[];
}

export interface DiffFile {
	path: string;
	status: string;
	diff: string;
}

export interface DiffDelta {
	additions: number;
	deletions: number;
	modifications: number;
	renames: number;
	files: DiffFile[];
}

export interface VcsToolEntry {
	name: string;
	[key: string]: unknown;
}

export interface ShadowVcs {
	timezone: string | null;
	getTools: () => VcsToolEntry[];
	shutdown: Effect.Effect<void>;
	record: (options?: { message?: string }) => Effect.Effect<string, VcsError>;
	head: Effect.Effect<CommitInfo, VcsError>;
	resolve: (point: PointInTime) => Effect.Effect<string, VcsError>;
	getCheckpoint: (nameOrId: string) => Effect.Effect<CommitInfo, VcsError>;
	listCheckpoints: (options?: {
		from?: PointInTime;
		to?: PointInTime;
		limit?: number;
	}) => Effect.Effect<CommitInfo[], VcsError>;
	diff: (options: { from: PointInTime; to: PointInTime; pathFilter?: string }) => Effect.Effect<DiffDelta, VcsError>;
	diffWorking: (options: { against: PointInTime; pathFilter?: string }) => Effect.Effect<DiffDelta, VcsError>;
	restore: (options: { to: PointInTime; pathFilter?: string }) => Effect.Effect<void, VcsError>;
	undo: Effect.Effect<void, VcsError>;
	redo: Effect.Effect<void, VcsError>;
	readAt: (options: { path: string; at: PointInTime }) => Effect.Effect<Buffer | null, VcsError>;
	checkpoint: (options: { name: string; message?: string }) => Effect.Effect<CommitInfo, VcsError>;
	deleteCheckpoint: (name: string) => Effect.Effect<void, VcsError>;
	listNamedCheckpoints: Effect.Effect<CommitInfo[], VcsError>;
	historyForPath: (options: { path: string; limit?: number }) => Effect.Effect<CommitInfo[], VcsError>;
	isClean: Effect.Effect<boolean, VcsError>;
	changedSinceHead: Effect.Effect<string[], VcsError>;
}

export const ShadowVcsTag = Context.GenericTag<ShadowVcs>("@piki/ShadowVcs");

const noOpVcs: ShadowVcs = {
	timezone: null,
	getTools: () => [],
	shutdown: Effect.void,
	record: () => Effect.succeed(""),
	head: Effect.fail(new VcsError({ operation: "head", message: "No-op VCS" })),
	resolve: () => Effect.fail(new VcsError({ operation: "resolve", message: "No-op VCS" })),
	getCheckpoint: () => Effect.fail(new VcsError({ operation: "getCheckpoint", message: "No-op VCS" })),
	listCheckpoints: (): Effect.Effect<CommitInfo[], VcsError> => Effect.succeed([]),
	diff: () => Effect.succeed({ additions: 0, deletions: 0, modifications: 0, renames: 0, files: [] }),
	diffWorking: () => Effect.succeed({ additions: 0, deletions: 0, modifications: 0, renames: 0, files: [] }),
	restore: () => Effect.void,
	undo: Effect.void,
	redo: Effect.void,
	readAt: () => Effect.succeed(null),
	checkpoint: () => Effect.fail(new VcsError({ operation: "checkpoint", message: "No-op VCS" })),
	deleteCheckpoint: () => Effect.void,
	listNamedCheckpoints: Effect.succeed([]),
	historyForPath: () => Effect.succeed([]),
	isClean: Effect.succeed(true),
	changedSinceHead: Effect.succeed([]),
};

export function makeNoOpVcsLayer() {
	return Layer.succeed(ShadowVcsTag, noOpVcs);
}

function git(worktreePath: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }): string {
	return execFileSync("git", [...args], {
		cwd: worktreePath,
		encoding: "utf8",
		stdio: "pipe",
		env: options?.env,
	});
}

function gitOk(worktreePath: string, args: readonly string[]): boolean {
	try {
		git(worktreePath, args);
		return true;
	} catch {
		return false;
	}
}

function isSafeRefSegment(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith(".") && !value.endsWith(".lock");
}

function shadowError(operation: string, message: string, cause?: unknown): VcsError {
	return new VcsError({ operation, message, cause });
}

function parseNameStatus(raw: string): DiffFile[] {
	if (raw.trim().length === 0) return [];
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const parts = line.split("\t");
			const status = parts[0] ?? "";
			const path = parts[parts.length - 1] ?? "";
			return { path, status, diff: "" };
		});
}

function countDiffStats(raw: string): Pick<DiffDelta, "additions" | "deletions" | "modifications" | "renames"> {
	let additions = 0;
	let deletions = 0;
	let modifications = 0;
	const renames = 0;
	for (const line of raw.trim().split("\n").filter(Boolean)) {
		const [added, deleted, path] = line.split("\t");
		if (added && added !== "-") additions += Number.parseInt(added, 10) || 0;
		if (deleted && deleted !== "-") deletions += Number.parseInt(deleted, 10) || 0;
		if (path) modifications++;
	}
	return { additions, deletions, modifications, renames };
}

function countWorktreeLines(worktreePath: string, path: string): number {
	try {
		const content = readFileSync(join(worktreePath, path), "utf8");
		if (content.length === 0) return 0;
		return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
	} catch {
		return 0;
	}
}

function makeCommit(worktreePath: string, message: string, parent: string | null): string {
	const tmpIndex = mkdtempSync(join(tmpdir(), "piki-shadow-vcs-"));
	const indexFile = join(tmpIndex, "index");
	try {
		const env = {
			...process.env,
			GIT_INDEX_FILE: indexFile,
			GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Piki Shadow VCS",
			GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "piki-shadow-vcs@example.invalid",
			GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Piki Shadow VCS",
			GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "piki-shadow-vcs@example.invalid",
		};
		if (gitOk(worktreePath, ["rev-parse", "--verify", "HEAD"])) {
			git(worktreePath, ["read-tree", "HEAD"], { env });
		} else {
			git(worktreePath, ["read-tree", "--empty"], { env });
		}
		git(worktreePath, ["add", "-A"], { env });
		const tree = git(worktreePath, ["write-tree"], { env }).trim();
		const args = parent ? ["commit-tree", tree, "-p", parent, "-m", message] : ["commit-tree", tree, "-m", message];
		return git(worktreePath, args, { env }).trim();
	} finally {
		rmSync(tmpIndex, { recursive: true, force: true });
	}
}

function normalizeRestorePath(path: string | undefined): string {
	if (!path) return ".";
	if (path === "." || path === "./") return ".";
	if (path.startsWith("/") || path.includes("..") || path.startsWith(":(") || path.trim() === "") {
		throw shadowError("restore", `Unsafe restore path: ${path}`);
	}
	return path;
}

export function makeShadowVcs(config: { worktreePath: string; timezone?: string | null }): ShadowVcs {
	const worktreePath = config.worktreePath;
	const headRef = "refs/piki/shadow/head";
	const recordPrefix = "refs/piki/shadow/records";
	const checkpointPrefix = "refs/piki/shadow/checkpoints";
	const redoStack: string[] = [];

	const readRef = (ref: string): string | null => {
		try {
			return git(worktreePath, ["rev-parse", "--verify", ref]).trim();
		} catch {
			return null;
		}
	};
	const updateRef = (ref: string, hash: string): void => {
		git(worktreePath, ["update-ref", ref, hash]);
	};
	const deleteRef = (ref: string): void => {
		git(worktreePath, ["update-ref", "-d", ref]);
	};
	const commitInfo = (commitHash: string, name = commitHash): CommitInfo => {
		const raw = git(worktreePath, ["show", "-s", "--format=%T%x00%ct%x00%s", commitHash]).trim();
		const [treeHash = "", timestamp = "0", message = ""] = raw.split("\0");
		const filesRaw = git(worktreePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitHash]).trim();
		return {
			name,
			operationId: name,
			commitHash,
			treeHash,
			timestamp: new Date((Number.parseInt(timestamp, 10) || 0) * 1000),
			message,
			filesChanged: filesRaw ? filesRaw.split("\n").filter(Boolean) : [],
		};
	};
	const listRefs = (prefix: string): CommitInfo[] => {
		const raw = git(worktreePath, ["for-each-ref", prefix, "--format=%(refname)%00%(objectname)"]).trim();
		if (!raw) return [];
		return raw
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [ref = "", hash = ""] = line.split("\0");
				const name = ref.slice(prefix.length + 1);
				return commitInfo(hash, name);
			})
			.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
	};
	const resolvePoint = (point: PointInTime): string => {
		if (typeof point === "string") {
			if (point === "head" || point === "latest" || point === "last") {
				const head = readRef(headRef);
				if (head) return head;
			}
			if (isSafeRefSegment(point)) {
				const checkpoint = readRef(`${checkpointPrefix}/${point}`);
				if (checkpoint) return checkpoint;
				const record = readRef(`${recordPrefix}/${point}`);
				if (record) return record;
			}
			if (/^[a-f0-9]{40,64}$/i.test(point) && gitOk(worktreePath, ["cat-file", "-e", point])) return point;
			throw shadowError("resolve", `Unknown point in time: ${point}`);
		}
		if (point.kind === "operation" || point.kind === "snapshot") {
			return resolvePoint(point.id);
		}
		if (point.kind === "checkpoint") {
			return resolvePoint(point.name);
		}
		if (point.kind === "relative") {
			const anchor = resolvePoint(point.anchor);
			const suffix = point.offset === 0 ? "" : point.offset > 0 ? `~-${point.offset}` : `~${Math.abs(point.offset)}`;
			const resolved = git(worktreePath, ["rev-parse", `${anchor}${suffix}`]).trim();
			if (resolved) return resolved;
		}
		if (point.kind === "time") {
			const candidates = [...listRefs(recordPrefix), ...listRefs(checkpointPrefix)].filter(
				(entry) => entry.timestamp.getTime() <= point.when.getTime(),
			);
			const candidate = candidates.at(-1);
			if (candidate) return candidate.commitHash;
		}
		if (point.kind === "message") {
			return resolvePoint(point.value);
		}
		throw shadowError("resolve", `Unsupported point in time: ${JSON.stringify(point)}`);
	};
	const diffBetween = (from: string, to: string, pathFilter?: string): DiffDelta => {
		const pathArgs = pathFilter ? ["--", pathFilter] : [];
		const files = parseNameStatus(git(worktreePath, ["diff", "--name-status", from, to, ...pathArgs]));
		const diff = git(worktreePath, ["diff", "--no-color", from, to, ...pathArgs]);
		const stats = countDiffStats(git(worktreePath, ["diff", "--numstat", from, to, ...pathArgs]));
		return { ...stats, files: files.map((file) => ({ ...file, diff })) };
	};

	return {
		timezone: config.timezone ?? null,
		getTools: () => [{ name: "checkpoint_changes" }, { name: "checkpoint_rollback" }],
		shutdown: Effect.void,
		record: (options) =>
			Effect.try({
				try: () => {
					const operationId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
					const parent = readRef(headRef);
					const commit = makeCommit(worktreePath, options?.message ?? `record ${operationId}`, parent);
					updateRef(`${recordPrefix}/${operationId}`, commit);
					updateRef(headRef, commit);
					redoStack.length = 0;
					return operationId;
				},
				catch: (cause) => shadowError("record", "Failed to record shadow VCS commit", cause),
			}),
		head: Effect.try({
			try: () => {
				const head = readRef(headRef);
				if (!head) throw shadowError("head", "No shadow VCS head");
				return commitInfo(head, "head");
			},
			catch: (cause) => (cause instanceof VcsError ? cause : shadowError("head", "Failed to read head", cause)),
		}),
		resolve: (point) =>
			Effect.try({
				try: () => resolvePoint(point),
				catch: (cause) =>
					cause instanceof VcsError ? cause : shadowError("resolve", "Failed to resolve point in time", cause),
			}),
		getCheckpoint: (nameOrId) =>
			Effect.try({
				try: () => commitInfo(resolvePoint({ kind: "checkpoint", name: nameOrId }), nameOrId),
				catch: (cause) =>
					cause instanceof VcsError
						? cause
						: shadowError("getCheckpoint", `Failed to read checkpoint ${nameOrId}`, cause),
			}),
		listCheckpoints: (options) =>
			Effect.try({
				try: () => {
					const fromTime = options?.from ? commitInfo(resolvePoint(options.from)).timestamp.getTime() : undefined;
					const toTime = options?.to ? commitInfo(resolvePoint(options.to)).timestamp.getTime() : undefined;
					const checkpoints = listRefs(checkpointPrefix).filter(
						(checkpoint) =>
							(fromTime === undefined || checkpoint.timestamp.getTime() >= fromTime) &&
							(toTime === undefined || checkpoint.timestamp.getTime() <= toTime),
					);
					return checkpoints.slice(-(options?.limit ?? Number.POSITIVE_INFINITY));
				},
				catch: (cause) => shadowError("listCheckpoints", "Failed to list checkpoints", cause),
			}),
		diff: (options) =>
			Effect.try({
				try: () => diffBetween(resolvePoint(options.from), resolvePoint(options.to), options.pathFilter),
				catch: (cause) => (cause instanceof VcsError ? cause : shadowError("diff", "Failed to diff points", cause)),
			}),
		diffWorking: (options) =>
			Effect.try({
				try: () => {
					const against = resolvePoint(options.against);
					const pathArgs = options.pathFilter ? ["--", options.pathFilter] : [];
					const files = parseNameStatus(git(worktreePath, ["diff", "--name-status", against, ...pathArgs]));
					const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard", ...pathArgs])
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((path) => ({ path, status: "A", diff: "" }));
					const diff = git(worktreePath, ["diff", "--no-color", against, ...pathArgs]);
					const stats = countDiffStats(git(worktreePath, ["diff", "--numstat", against, ...pathArgs]));
					const untrackedAdditions = untracked.reduce(
						(total, file) => total + countWorktreeLines(worktreePath, file.path),
						0,
					);
					return {
						...stats,
						additions: stats.additions + untrackedAdditions,
						modifications: stats.modifications + untracked.length,
						files: [...files.map((file) => ({ ...file, diff })), ...untracked],
					};
				},
				catch: (cause) =>
					cause instanceof VcsError ? cause : shadowError("diffWorking", "Failed to diff worktree", cause),
			}),
		restore: (options) =>
			Effect.try({
				try: () => {
					const current = readRef(headRef);
					if (current) redoStack.push(current);
					const target = resolvePoint(options.to);
					const restorePath = normalizeRestorePath(options.pathFilter);
					const cleanArgs = ["clean", "-fd", "-e", ".piki"];
					if (restorePath !== ".") cleanArgs.push("--", restorePath);
					git(worktreePath, cleanArgs);
					git(worktreePath, ["checkout", "--no-overlay", target, "--", restorePath]);
					updateRef(headRef, target);
				},
				catch: (cause) => (cause instanceof VcsError ? cause : shadowError("restore", "Failed to restore", cause)),
			}),
		undo: Effect.try({
			try: () => {
				const head = readRef(headRef);
				if (!head) throw shadowError("undo", "No shadow VCS head");
				const parent = git(worktreePath, ["rev-parse", `${head}^`]).trim();
				redoStack.push(head);
				git(worktreePath, ["clean", "-fd", "-e", ".piki"]);
				git(worktreePath, ["checkout", "--no-overlay", parent, "--", "."]);
				updateRef(headRef, parent);
			},
			catch: (cause) => (cause instanceof VcsError ? cause : shadowError("undo", "Failed to undo", cause)),
		}),
		redo: Effect.try({
			try: () => {
				const target = redoStack.pop();
				if (!target) throw shadowError("redo", "No redo target");
				git(worktreePath, ["clean", "-fd", "-e", ".piki"]);
				git(worktreePath, ["checkout", "--no-overlay", target, "--", "."]);
				updateRef(headRef, target);
			},
			catch: (cause) => (cause instanceof VcsError ? cause : shadowError("redo", "Failed to redo", cause)),
		}),
		readAt: (options) =>
			Effect.try({
				try: () => {
					const point = resolvePoint(options.at);
					try {
						return Buffer.from(git(worktreePath, ["show", `${point}:${options.path}`]));
					} catch {
						return null;
					}
				},
				catch: (cause) => (cause instanceof VcsError ? cause : shadowError("readAt", "Failed to read file", cause)),
			}),
		checkpoint: (options) =>
			Effect.try({
				try: () => {
					if (!isSafeRefSegment(options.name))
						throw shadowError("checkpoint", `Unsafe checkpoint name ${options.name}`);
					const parent = readRef(headRef);
					const commit = makeCommit(worktreePath, options.message ?? `checkpoint ${options.name}`, parent);
					updateRef(`${checkpointPrefix}/${options.name}`, commit);
					updateRef(headRef, commit);
					return commitInfo(commit, options.name);
				},
				catch: (cause) =>
					cause instanceof VcsError ? cause : shadowError("checkpoint", "Failed to create checkpoint", cause),
			}),
		deleteCheckpoint: (name) =>
			Effect.try({
				try: () => {
					if (!isSafeRefSegment(name)) throw shadowError("deleteCheckpoint", `Unsafe checkpoint name ${name}`);
					deleteRef(`${checkpointPrefix}/${name}`);
				},
				catch: (cause) =>
					cause instanceof VcsError
						? cause
						: shadowError("deleteCheckpoint", `Failed to delete checkpoint ${name}`, cause),
			}),
		listNamedCheckpoints: Effect.try({
			try: () => listRefs(checkpointPrefix),
			catch: (cause) => shadowError("listNamedCheckpoints", "Failed to list named checkpoints", cause),
		}),
		historyForPath: (options) =>
			Effect.try({
				try: () => {
					const raw = git(worktreePath, [
						"log",
						`--max-count=${options.limit ?? 50}`,
						"--format=%H",
						headRef,
						"--",
						options.path,
					]).trim();
					return raw
						.split("\n")
						.filter(Boolean)
						.map((hash) => commitInfo(hash, hash));
				},
				catch: (cause) => shadowError("historyForPath", `Failed to read history for ${options.path}`, cause),
			}),
		isClean: Effect.try({
			try: () => git(worktreePath, ["status", "--porcelain"]).trim().length === 0,
			catch: (cause) => shadowError("isClean", "Failed to read git status", cause),
		}),
		changedSinceHead: Effect.try({
			try: () =>
				git(worktreePath, ["status", "--porcelain"])
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => line.slice(3)),
			catch: (cause) => shadowError("changedSinceHead", "Failed to read changed files", cause),
		}),
	};
}

export function makeShadowVcsLayer(config: { backend: unknown; worktreePath: string; timezone?: string | null }) {
	return Layer.succeed(ShadowVcsTag, makeShadowVcs(config));
}
