import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { userMsg } from "./utilities.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("SessionManager sidecars", () => {
	it("persists a new session header immediately", () => {
		const cwd = mkdtempSync(join(tmpdir(), "piki-session-sidecar-"));
		tempDirs.push(cwd);
		const sessionManager = SessionManager.create(cwd);
		const sessionFile = sessionManager.getSessionFile();

		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);
		expect(readFileSync(sessionFile!, "utf-8")).toContain('"type":"session"');
	});

	it("exposes sidecar paths alongside the session file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "piki-session-sidecar-"));
		tempDirs.push(cwd);
		const sessionManager = SessionManager.create(cwd);

		expect(sessionManager.getSessionMetaFile()).toMatch(/\.meta\.json$/);
		expect(existsSync(sessionManager.getSessionMetaFile()!)).toBe(true);
		expect(sessionManager.getSessionEventsFile()).toMatch(/\.events\.jsonl$/);
		expect(sessionManager.getSessionProjectionsFile()).toMatch(/\.projections\.json$/);
	});

	it("appends non-assistant messages without deferring file creation", () => {
		const cwd = mkdtempSync(join(tmpdir(), "piki-session-sidecar-"));
		tempDirs.push(cwd);
		const sessionManager = SessionManager.create(cwd);
		const sessionFile = sessionManager.getSessionFile()!;

		sessionManager.appendMessage(userMsg("hello"));

		const content = readFileSync(sessionFile, "utf-8");
		expect(content).toContain('"role":"user"');
	});

	it("updates metadata sidecar as messages are appended", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piki-session-sidecar-"));
		tempDirs.push(cwd);
		const sessionManager = SessionManager.create(cwd);
		const metaFile = sessionManager.getSessionMetaFile()!;

		sessionManager.appendMessage(userMsg("first request"));
		sessionManager.appendMessage(userMsg("latest request"));

		const meta = JSON.parse(readFileSync(metaFile, "utf-8")) as Record<string, unknown>;
		expect(meta.sessionId).toBe(sessionManager.getSessionId());
		expect(meta.cwd).toBe(cwd);
		expect(meta.firstUserMessage).toBe("first request");
		expect(meta.lastMessage).toBe("latest request");
		expect(meta.messageCount).toBe(2);

		const [listed] = await SessionManager.list(cwd);
		expect(listed?.firstMessage).toBe("first request");
		expect(listed?.messageCount).toBe(2);
	});
});
