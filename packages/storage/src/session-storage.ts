import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { uuidv7 } from "@piki/agent-core";
import { Context, Data, Effect, Layer } from "effect";
import { GlobalStorageTag } from "./global-storage.ts";
import { type GlobalStoragePaths, SCRATCHPAD_SUBDIRS } from "./paths.ts";
import { VersionTag } from "./version.ts";

export interface StoredSessionMeta {
	sessionId: string;
	cwd?: string;
	createdAt: string;
	updatedAt: string;
	gitBranch?: string;
	initialVersion?: string;
	lastActiveVersion?: string;
	[key: string]: unknown;
}

export interface PendingMemoryExtractionJob {
	jobId: string;
	sessionId: string;
	cwd: string;
	eventsPath: string;
	memoryPath: string;
	createdAt: string;
	attempts: number;
	status: "pending" | "running";
}

export class SessionStorageError extends Data.TaggedError("SessionStorageError")<{
	readonly operation: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export interface SessionStorage {
	paths: GlobalStoragePaths;
	createTimestampSessionId: Effect.Effect<string>;
	listSessionIds: Effect.Effect<string[], SessionStorageError>;
	findLatestSessionId: Effect.Effect<string | undefined, SessionStorageError>;
	readMeta: (sessionId: string) => Effect.Effect<StoredSessionMeta, SessionStorageError>;
	writeMeta: (sessionId: string, meta: StoredSessionMeta) => Effect.Effect<void, SessionStorageError>;
	updateMeta: (
		sessionId: string,
		f: (meta: StoredSessionMeta) => StoredSessionMeta,
	) => Effect.Effect<StoredSessionMeta, SessionStorageError>;
	readEvents: (sessionId: string) => Effect.Effect<unknown[], SessionStorageError>;
	readEventsFromPath: (path: string) => Effect.Effect<unknown[], SessionStorageError>;
	appendEvents: (sessionId: string, events: readonly unknown[]) => Effect.Effect<void, SessionStorageError>;
	appendLogs: (sessionId: string, entries: readonly unknown[]) => Effect.Effect<void, SessionStorageError>;
	clearLog: (sessionId: string) => Effect.Effect<void, SessionStorageError>;
	createSessionScratchpad: (sessionId: string) => Effect.Effect<string, SessionStorageError>;
	createPendingMemoryExtractionJob: (input: {
		sessionId: string;
		cwd: string;
		eventsPath: string;
		memoryPath: string;
	}) => Effect.Effect<PendingMemoryExtractionJob, SessionStorageError>;
	writePendingMemoryExtractionJob: (job: PendingMemoryExtractionJob) => Effect.Effect<void, SessionStorageError>;
	listPendingMemoryExtractionJobIds: Effect.Effect<string[], SessionStorageError>;
	readPendingMemoryExtractionJob: (jobId: string) => Effect.Effect<PendingMemoryExtractionJob, SessionStorageError>;
	markPendingMemoryExtractionJobRunning: (
		jobId: string,
	) => Effect.Effect<PendingMemoryExtractionJob, SessionStorageError>;
	markPendingMemoryExtractionJobPending: (
		jobId: string,
	) => Effect.Effect<PendingMemoryExtractionJob, SessionStorageError>;
	removePendingMemoryExtractionJob: (jobId: string) => Effect.Effect<void, SessionStorageError>;
}

export const SessionStorageTag = Context.GenericTag<SessionStorage>("@piki/SessionStorage");

function fail(operation: string, message: string, cause: unknown): SessionStorageError {
	return new SessionStorageError({ operation, message, cause });
}

function readJsonFile<T>(path: string, operation: string): Effect.Effect<T, SessionStorageError> {
	return Effect.tryPromise({
		try: async () => JSON.parse(await readFile(path, "utf8")) as T,
		catch: (cause) => fail(operation, `Failed to read JSON file ${path}`, cause),
	});
}

function writeJsonFile(path: string, value: unknown, operation: string): Effect.Effect<void, SessionStorageError> {
	return Effect.tryPromise({
		try: async () => {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		},
		catch: (cause) => fail(operation, `Failed to write JSON file ${path}`, cause),
	});
}

function readJsonLines(path: string): Effect.Effect<unknown[], SessionStorageError> {
	return Effect.tryPromise({
		try: async () => {
			try {
				const raw = await readFile(path, "utf8");
				return raw
					.split(/\r?\n/)
					.filter((line) => line.trim().length > 0)
					.map((line) => JSON.parse(line) as unknown);
			} catch (error) {
				if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
				throw error;
			}
		},
		catch: (cause) => fail("readEvents", `Failed to read JSONL file ${path}`, cause),
	});
}

function appendJsonLines(
	path: string,
	entries: readonly unknown[],
	operation: string,
): Effect.Effect<void, SessionStorageError> {
	return Effect.tryPromise({
		try: async () => {
			if (entries.length === 0) return;
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await appendFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
		},
		catch: (cause) => fail(operation, `Failed to append JSONL file ${path}`, cause),
	});
}

function makeSessionStorage(paths: GlobalStoragePaths, version: string): SessionStorage {
	const readJob = (jobId: string) =>
		readJsonFile<PendingMemoryExtractionJob>(paths.pendingMemoryJobFile(jobId), "readPendingMemoryExtractionJob");
	const writeJob = (job: PendingMemoryExtractionJob) =>
		writeJsonFile(paths.pendingMemoryJobFile(job.jobId), job, "writePendingMemoryExtractionJob");
	return {
		paths,
		createTimestampSessionId: Effect.sync(() => uuidv7()),
		listSessionIds: Effect.tryPromise({
			try: async () => {
				try {
					const entries = await readdir(paths.sessionsRoot, { withFileTypes: true });
					return entries
						.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
						.map((entry) => entry.name)
						.sort();
				} catch (error) {
					if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
					throw error;
				}
			},
			catch: (cause) => fail("listSessionIds", `Failed to list sessions ${paths.sessionsRoot}`, cause),
		}),
		findLatestSessionId: Effect.map(
			Effect.tryPromise({
				try: async () => {
					try {
						const entries = await readdir(paths.sessionsRoot, { withFileTypes: true });
						return entries
							.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
							.map((entry) => entry.name)
							.sort()
							.at(-1);
					} catch (error) {
						if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
							return undefined;
						throw error;
					}
				},
				catch: (cause) =>
					fail("findLatestSessionId", `Failed to find latest session in ${paths.sessionsRoot}`, cause),
			}),
			(id) => id,
		),
		readMeta: (sessionId) => readJsonFile(paths.sessionMetaFile(sessionId), "readMeta"),
		writeMeta: (sessionId, meta) =>
			writeJsonFile(
				paths.sessionMetaFile(sessionId),
				{ ...meta, sessionId, updatedAt: meta.updatedAt, lastActiveVersion: meta.lastActiveVersion ?? version },
				"writeMeta",
			),
		updateMeta: (sessionId, f) =>
			Effect.flatMap(readJsonFile<StoredSessionMeta>(paths.sessionMetaFile(sessionId), "updateMeta"), (meta) => {
				const next = f(meta);
				return Effect.as(writeJsonFile(paths.sessionMetaFile(sessionId), next, "updateMeta"), next);
			}),
		readEvents: (sessionId) => readJsonLines(paths.sessionEventsFile(sessionId)),
		readEventsFromPath: readJsonLines,
		appendEvents: (sessionId, events) => appendJsonLines(paths.sessionEventsFile(sessionId), events, "appendEvents"),
		appendLogs: (sessionId, entries) => appendJsonLines(paths.sessionLogFile(sessionId), entries, "appendLogs"),
		clearLog: (sessionId) =>
			Effect.tryPromise({
				try: async () => {
					await rm(paths.sessionLogFile(sessionId), { force: true });
				},
				catch: (cause) => fail("clearLog", `Failed to clear session log ${paths.sessionLogFile(sessionId)}`, cause),
			}),
		createSessionScratchpad: (sessionId) =>
			Effect.tryPromise({
				try: async () => {
					const scratchpad = paths.sessionScratchpad(sessionId);
					await mkdir(scratchpad, { recursive: true, mode: 0o700 });
					await Promise.all(
						SCRATCHPAD_SUBDIRS.map((subdir) =>
							mkdir(paths.sessionScratchpadSubdir(sessionId, subdir), { recursive: true, mode: 0o700 }),
						),
					);
					return scratchpad;
				},
				catch: (cause) => fail("createSessionScratchpad", `Failed to create scratchpad for ${sessionId}`, cause),
			}),
		createPendingMemoryExtractionJob: (input) =>
			Effect.flatMap(
				Effect.sync(() => uuidv7()),
				(jobId) => {
					const now = new Date().toISOString();
					const job: PendingMemoryExtractionJob = {
						jobId,
						sessionId: input.sessionId,
						cwd: input.cwd,
						eventsPath: input.eventsPath,
						memoryPath: input.memoryPath,
						createdAt: now,
						attempts: 0,
						status: "pending",
					};
					return Effect.as(writeJob(job), job);
				},
			),
		writePendingMemoryExtractionJob: writeJob,
		listPendingMemoryExtractionJobIds: Effect.tryPromise({
			try: async () => {
				try {
					const entries = await readdir(paths.pendingMemoryExtractionRoot, { withFileTypes: true });
					return entries
						.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
						.map((entry) => entry.name.slice(0, -".json".length))
						.sort();
				} catch (error) {
					if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
					throw error;
				}
			},
			catch: (cause) =>
				fail("listPendingMemoryExtractionJobIds", `Failed to list ${paths.pendingMemoryExtractionRoot}`, cause),
		}),
		readPendingMemoryExtractionJob: readJob,
		markPendingMemoryExtractionJobRunning: (jobId) =>
			Effect.flatMap(readJob(jobId), (job) => {
				const next = { ...job, status: "running" as const, attempts: job.attempts + 1 };
				return Effect.as(writeJob(next), next);
			}),
		markPendingMemoryExtractionJobPending: (jobId) =>
			Effect.flatMap(readJob(jobId), (job) => {
				const next = { ...job, status: "pending" as const };
				return Effect.as(writeJob(next), next);
			}),
		removePendingMemoryExtractionJob: (jobId) =>
			Effect.tryPromise({
				try: async () => {
					await rm(paths.pendingMemoryJobFile(jobId), { force: true });
				},
				catch: (cause) =>
					fail(
						"removePendingMemoryExtractionJob",
						`Failed to remove job ${paths.pendingMemoryJobFile(jobId)}`,
						cause,
					),
			}),
	};
}

export const SessionStorageLive = Layer.scoped(
	SessionStorageTag,
	Effect.gen(function* () {
		const globalStorage = yield* GlobalStorageTag;
		const version = yield* VersionTag;
		return SessionStorageTag.of(makeSessionStorage(globalStorage.paths, version.getVersion()));
	}),
);
