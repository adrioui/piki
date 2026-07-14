import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import { ProjectStorageTag } from "./project-storage.ts";

const DEFAULT_MEMORY_CONTENT = "# Project Memory\n";

export class MemoryStorageError extends Data.TaggedError("MemoryStorageError")<{
	readonly operation: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export interface MemoryStorage {
	ensureFile: Effect.Effect<string, MemoryStorageError>;
	read: Effect.Effect<string, MemoryStorageError>;
	write: (content: string) => Effect.Effect<void, MemoryStorageError>;
}

export const MemoryStorageTag = Context.GenericTag<MemoryStorage>("@piki/FileMemoryStorage");

function makeMemoryStorage(memoryFile: string): MemoryStorage {
	const write = (content: string) =>
		Effect.tryPromise({
			try: async () => {
				await mkdir(dirname(memoryFile), { recursive: true, mode: 0o700 });
				await writeFile(memoryFile, content, "utf8");
			},
			catch: (cause) =>
				new MemoryStorageError({ operation: "write", message: `Failed to write memory ${memoryFile}`, cause }),
		});
	const ensureFile = Effect.catchTag(
		Effect.tryPromise({
			try: async () => readFile(memoryFile, "utf8"),
			catch: (cause) =>
				new MemoryStorageError({ operation: "read", message: `Failed to read memory ${memoryFile}`, cause }),
		}),
		"MemoryStorageError",
		(error) => {
			const cause = error.cause;
			if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
				return Effect.as(write(DEFAULT_MEMORY_CONTENT), DEFAULT_MEMORY_CONTENT);
			}
			return Effect.fail(error);
		},
	);
	return {
		ensureFile,
		read: ensureFile,
		write,
	};
}

export const MemoryStorageLive = Layer.scoped(
	MemoryStorageTag,
	Effect.map(ProjectStorageTag, (projectStorage) =>
		MemoryStorageTag.of(makeMemoryStorage(projectStorage.paths.memoryFile)),
	),
);
