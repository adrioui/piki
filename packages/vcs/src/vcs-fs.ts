import * as fs from "node:fs/promises";
import { Context, Effect, Layer } from "effect";

export interface VcsFs {
	readFile: (path: string) => Effect.Effect<Buffer, unknown>;
	writeFile: (path: string, content: string | Buffer) => Effect.Effect<void, unknown>;
	readFileAt: (treeHash: string, path: string) => Effect.Effect<Buffer | null, never>;
	readWorktreeFile: (path: string) => Effect.Effect<Buffer, unknown>;
	getChangedFiles: () => Effect.Effect<ChangedFile[], never>;
	buildCommit: (options: { message: string }) => Effect.Effect<string, never>;
	readRef: (ref: string) => Effect.Effect<string | null, never>;
	writeRef: (ref: string, hash: string) => Effect.Effect<void, never>;
	listRefs: (prefix: string) => Effect.Effect<RefEntry[], never>;
	walkHistory: (options: {
		start?: string;
		limit?: number;
		pathFilter?: string;
	}) => Effect.Effect<CommitEntry[], never>;
	diffTree: (fromTree: string, toTree: string) => Effect.Effect<TreeDiff, never>;
}

export interface ChangedFile {
	path: string;
	status: "added" | "modified" | "deleted";
}

export interface RefEntry {
	ref: string;
	hash: string;
}

export interface CommitEntry {
	hash: string;
	tree: string;
	parents: string[];
	message: string;
	committer: { timestamp: number };
}

export interface TreeDiff {
	files: { path: string; status: string }[];
}

export const VcsFsTag = Context.GenericTag<VcsFs>("@piki/VcsFs");

const realFs: VcsFs = {
	readFile: (path) => Effect.tryPromise(async () => await fs.readFile(path)),
	writeFile: (path, content) => Effect.tryPromise(async () => await fs.writeFile(path, content)),
	readFileAt: () => Effect.succeed(null),
	readWorktreeFile: (path) => Effect.tryPromise(async () => await fs.readFile(path)),
	getChangedFiles: () => Effect.succeed([]),
	buildCommit: () => Effect.succeed(""),
	readRef: () => Effect.succeed(null),
	writeRef: () => Effect.void,
	listRefs: () => Effect.succeed([]),
	walkHistory: () => Effect.succeed([]),
	diffTree: () => Effect.succeed({ files: [] }),
};

export const VcsFsLive = Layer.succeed(VcsFsTag, realFs);
