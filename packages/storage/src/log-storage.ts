import { appendFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import { GlobalStorageTag } from "./global-storage.ts";

export class LogStorageError extends Data.TaggedError("LogStorageError")<{
	readonly operation: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export interface LogStorage {
	appendSession: (sessionId: string, entry: unknown) => Effect.Effect<void, LogStorageError>;
	clearSession: (sessionId: string) => Effect.Effect<void, LogStorageError>;
	getSessionPath: (sessionId: string) => string;
	appendCli: (entry: unknown) => Effect.Effect<void, LogStorageError>;
	appendEvent: (entry: unknown) => Effect.Effect<void, LogStorageError>;
}

export const LogStorageTag = Context.GenericTag<LogStorage>("@piki/LogStorage");

function appendJsonLine(path: string, entry: unknown, operation: string): Effect.Effect<void, LogStorageError> {
	return Effect.tryPromise({
		try: async () => {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
		},
		catch: (cause) => new LogStorageError({ operation, message: `Failed to append log ${path}`, cause }),
	});
}

function makeLogStorage(paths: {
	sessionLogFile: (sessionId: string) => string;
	cliLogFile: string;
	eventLogFile: string;
}): LogStorage {
	return {
		appendSession: (sessionId, entry) => appendJsonLine(paths.sessionLogFile(sessionId), entry, "appendSession"),
		clearSession: (sessionId) =>
			Effect.tryPromise({
				try: async () => {
					await rm(paths.sessionLogFile(sessionId), { force: true });
				},
				catch: (cause) =>
					new LogStorageError({
						operation: "clearSession",
						message: `Failed to clear session log ${paths.sessionLogFile(sessionId)}`,
						cause,
					}),
			}),
		getSessionPath: paths.sessionLogFile,
		appendCli: (entry) => appendJsonLine(paths.cliLogFile, entry, "appendCli"),
		appendEvent: (entry) => appendJsonLine(paths.eventLogFile, entry, "appendEvent"),
	};
}

export const LogStorageLive = Layer.scoped(
	LogStorageTag,
	Effect.map(GlobalStorageTag, (globalStorage) => LogStorageTag.of(makeLogStorage(globalStorage.paths))),
);
