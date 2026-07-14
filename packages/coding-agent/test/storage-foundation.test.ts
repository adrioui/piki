import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	ConfigStorageTag,
	createStorageClient,
	LogStorageTag,
	MemoryStorageTag,
	SCRATCHPAD_SUBDIRS,
	SessionStorageTag,
} from "../src/core/storage/index.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("storage foundation", () => {
	it("creates a storage client with isolated global and project roots", async () => {
		const globalRoot = makeTempDir("piki-storage-global-");
		const cwd = makeTempDir("piki-storage-project-");
		const client = createStorageClient({ cwd, globalRoot, version: "0.0.0-test" });

		try {
			const result = await client.runtime.runPromise(
				Effect.gen(function* () {
					const config = yield* ConfigStorageTag;
					const memory = yield* MemoryStorageTag;
					const sessions = yield* SessionStorageTag;
					const logs = yield* LogStorageTag;

					yield* config.setContextLimitPolicy({ softCapRatio: 0.7, softCapMaxTokens: 80_000 });
					yield* memory.write("Remember this project fact.");
					const sessionId = yield* sessions.createTimestampSessionId;
					const now = new Date().toISOString();
					yield* sessions.writeMeta(sessionId, {
						sessionId,
						cwd,
						createdAt: now,
						updatedAt: now,
					});
					yield* sessions.appendEvents(sessionId, [{ type: "message", text: "hello" }]);
					yield* logs.appendSession(sessionId, { level: "info", message: "ok" });
					const scratchpad = yield* sessions.createSessionScratchpad(sessionId);
					const job = yield* sessions.createPendingMemoryExtractionJob({
						sessionId,
						cwd,
						eventsPath: sessions.paths.sessionEventsFile(sessionId),
						memoryPath: join(cwd, ".piki", "memory.md"),
					});
					const runningJob = yield* sessions.markPendingMemoryExtractionJobRunning(job.jobId);

					return {
						policy: yield* config.getContextLimitPolicy,
						memoryText: yield* memory.read,
						meta: yield* sessions.readMeta(sessionId),
						events: yield* sessions.readEvents(sessionId),
						sessionLogPath: logs.getSessionPath(sessionId),
						scratchpad,
						scratchpadSubdirs: SCRATCHPAD_SUBDIRS.map((subdir) =>
							sessions.paths.sessionScratchpadSubdir(sessionId, subdir),
						),
						jobIds: yield* sessions.listPendingMemoryExtractionJobIds,
						runningJob,
					};
				}),
			);

			expect(result.policy).toEqual({ softCapRatio: 0.7, softCapMaxTokens: 80_000 });
			expect(result.memoryText).toBe("Remember this project fact.");
			expect(result.meta.cwd).toBe(cwd);
			expect(result.meta.lastActiveVersion).toBe("0.0.0-test");
			expect(result.events).toEqual([{ type: "message", text: "hello" }]);
			expect(existsSync(result.sessionLogPath)).toBe(true);
			expect(readFileSync(result.sessionLogPath, "utf8")).toContain('"message":"ok"');
			expect(existsSync(result.scratchpad)).toBe(true);
			expect(result.scratchpadSubdirs.every((path) => existsSync(path))).toBe(true);
			expect(result.jobIds).toEqual([result.runningJob.jobId]);
			expect(result.runningJob.status).toBe("running");
			expect(result.runningJob.attempts).toBe(1);
		} finally {
			await client.runtime.dispose();
		}
	});
});
