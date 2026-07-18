import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlSessionStorage } from "../../agent/src/harness/session/jsonl-storage.ts";
import { SessionError } from "../../agent/src/harness/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";

type JsonlSessionStorageFileSystem = Parameters<typeof JsonlSessionStorage.open>[0];

// In-memory FileSystem for harness layer probes (mirrors node fs semantics).
function memFs(): { fs: JsonlSessionStorageFileSystem; files: Map<string, string> } {
	const files = new Map<string, string>();
	const fs: JsonlSessionStorageFileSystem = {
		readTextFile: async (p) => {
			if (!files.has(p)) {
				return { ok: false, error: { name: "FileError", code: "not_found", message: "ENOENT" } };
			}
			return { ok: true, value: files.get(p)! };
		},
		readTextLines: async (p, opts) => {
			const content = files.get(p) ?? "";
			const lines = content.split("\\n").filter((l) => l.trim());
			return { ok: true, value: opts?.maxLines ? lines.slice(0, opts.maxLines) : lines };
		},
		writeFile: async (p, content) => {
			files.set(p, typeof content === "string" ? content : new TextDecoder().decode(content));
			return { ok: true, value: undefined };
		},
		appendFile: async (p, content) => {
			const text = typeof content === "string" ? content : new TextDecoder().decode(content);
			files.set(p, (files.get(p) ?? "") + text);
			return { ok: true, value: undefined };
		},
	};
	return { fs, files };
}

describe("S7 session parity probes", () => {
	describe("corrupt jsonl line recovery", () => {
		it("SessionManager skips a malformed line and keeps valid entries (more resilient than mag)", () => {
			const dir = mkdtempSync(join(tmpdir(), "piki-s7-"));
			try {
				const file = join(dir, "session.jsonl");
				// valid header + valid message + GARBAGE line + another valid message
				writeFileSync(
					file,
					`${[
						JSON.stringify({
							type: "session",
							version: 3,
							id: "s1",
							timestamp: new Date().toISOString(),
							cwd: dir,
						}),
						JSON.stringify({
							type: "message",
							id: "m1",
							parentId: null,
							timestamp: new Date().toISOString(),
							message: { role: "user", content: "hello" },
						}),
						"{this is not json",
						JSON.stringify({
							type: "message",
							id: "m2",
							parentId: "m1",
							timestamp: new Date().toISOString(),
							message: { role: "assistant", content: "hi" },
						}),
						"",
					].join("\n")}\n`,
				);
				// loadEntriesFromFile is exercised via SessionManager.open
				const sm = SessionManager.open(file, undefined, dir);
				const entries = sm.getEntries();
				const ids = entries.map((e) => e.id);
				expect(ids).toContain("m1");
				expect(ids).toContain("m2");
				expect(ids).not.toContain(undefined as unknown);
				expect(entries.length).toBe(2);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("harness JsonlSessionStorage THROWS on a malformed line (matches mag readJsonLines hard-fail)", async () => {
			const { fs, files } = memFs();
			const file = "/s/session.jsonl";
			files.set(
				file,
				`${[
					JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: "/" }),
					JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString() }),
					"not-json-line",
				].join("\n")}\n`,
			);
			await expect(JsonlSessionStorage.open(fs, file)).rejects.toBeInstanceOf(SessionError);
		});

		it("piki SessionManager is MORE resilient than mag: a line mag would throw on is tolerated", () => {
			// mag readJsonLines has no per-line catch; piki's parseSessionEntryLine catches.
			// This asserts the asymmetry direction explicitly.
			const dir = mkdtempSync(join(tmpdir(), "piki-s7-"));
			try {
				const file = join(dir, "session.jsonl");
				writeFileSync(
					file,
					`${[
						JSON.stringify({
							type: "session",
							version: 3,
							id: "s1",
							timestamp: new Date().toISOString(),
							cwd: dir,
						}),
						"@@@corrupt@@@",
					].join("\n")}\n`,
				);
				// Even a header + only-corrupt-body must not throw; entries len 0 is fine.
				const sm = SessionManager.open(file, undefined, dir);
				expect(sm.getEntries().length).toBe(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("resume restores leaf", () => {
		it("resume rebuilds entries and a persisted branch leaf id survives reopen", () => {
			const dir = mkdtempSync(join(tmpdir(), "piki-s7-"));
			try {
				const sm1 = SessionManager.create(dir, dir, { id: "resume1" });
				sm1.appendMessage({ role: "user", content: "a" } as never);
				const m2 = sm1.appendMessage({ role: "assistant", content: "b" } as never);
				sm1.appendMessage({ role: "user", content: "c" } as never);
				// create a branch at m2
				sm1.branch(m2);
				const file = sm1.getSessionFile()!;
				expect(existsSync(file)).toBe(true);

				const sm2 = SessionManager.open(file, dir);
				expect(sm2.getLeafId()).toBe(m2);
				expect(sm2.getEntries().length).toBe(3);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("session id format", () => {
		it("uses uuidv7 (not mag's cuid2/timestamp-id)", () => {
			const sm = SessionManager.inMemory();
			const id = sm.getSessionId();
			// uuidv7 is 36 chars with dashes
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		});
	});
});
