import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SessionOrchestrator } from "../../../src/core/session-orchestrator.ts";
import { userMsg } from "../../utilities.ts";

/**
 * Regression for A3: the `SessionOrchestrator` runtime sidecar and the
 * `SessionManager` preview meta must live on distinct files. Previously both
 * wrote to `<session>.meta.json`, so the last writer won. After the fix the
 * orchestrator writes `<session>.runtime-meta.json` and the manager keeps
 * `<session>.meta.json`, so neither clobbers the other's schema.
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Same validation contract as `readSessionMeta` (session-manager.ts). */
function isValidSessionMeta(raw: string): boolean {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return false;
	}
	return (
		typeof parsed.sessionId === "string" &&
		typeof parsed.created === "string" &&
		typeof parsed.updated === "string" &&
		typeof parsed.cwd === "string" &&
		typeof parsed.firstUserMessage === "string" &&
		typeof parsed.lastMessage === "string" &&
		typeof parsed.messageCount === "number"
	);
}

function driveOrchestratorSidecar(sessionManager: SessionManager): void {
	const orchestrator = Object.create(SessionOrchestrator.prototype) as {
		metaPath?: string;
		projectionsPath?: string;
		sequence: number;
		lastEventId: string | undefined;
		session: { sessionId: string; sessionFile: string | undefined; sessionManager: SessionManager };
		tasteStore: { getProfilePath: (cwd: string) => string | undefined };
		sink: { projections: () => Map<string, unknown> };
		writeSidecars: () => void;
	};
	orchestrator.metaPath = sessionManager.getSessionRuntimeMetaFile();
	orchestrator.projectionsPath = sessionManager.getSessionProjectionsFile();
	orchestrator.sequence = 1;
	orchestrator.lastEventId = "evt-1";
	orchestrator.session = {
		sessionId: sessionManager.getSessionId(),
		sessionFile: sessionManager.getSessionFile(),
		sessionManager,
	};
	orchestrator.tasteStore = { getProfilePath: () => undefined };
	orchestrator.sink = { projections: () => new Map<string, unknown>() };
	orchestrator.writeSidecars();
}

describe("A3: meta.json / runtime-meta.json are distinct sidecars", () => {
	it("maps the orchestrator runtime meta to a separate .runtime-meta.json path", () => {
		const cwd = mkdtempSync(join(tmpdir(), "piki-a3-path-"));
		tempDirs.push(cwd);
		const sessionManager = SessionManager.create(cwd);

		const metaFile = sessionManager.getSessionMetaFile()!;
		const runtimeMetaFile = sessionManager.getSessionRuntimeMetaFile()!;

		expect(metaFile).toMatch(/\.meta\.json$/);
		expect(runtimeMetaFile).toMatch(/\.runtime-meta\.json$/);
		expect(runtimeMetaFile).not.toBe(metaFile);
	});

	it("keeps .meta.json a valid SessionMeta while the orchestrator writes .runtime-meta.json", () => {
		const cwd = mkdtempSync(join(tmpdir(), "piki-a3-collision-"));
		tempDirs.push(cwd);
		const sessionManager = SessionManager.create(cwd);
		const metaFile = sessionManager.getSessionMetaFile()!;
		const runtimeMetaFile = sessionManager.getSessionRuntimeMetaFile()!;

		// Interleave manager appends (SessionMeta) and orchestrator runtime
		// events (SessionRuntimeMeta) the way a live session would.
		for (let i = 0; i < 3; i++) {
			sessionManager.appendMessage(userMsg(`user message ${i}`));
			expect(isValidSessionMeta(readFileSync(metaFile, "utf-8"))).toBe(true);

			driveOrchestratorSidecar(sessionManager);
			expect(existsSync(runtimeMetaFile)).toBe(true);
			const runtimeRaw = readFileSync(runtimeMetaFile, "utf-8");
			expect(isValidSessionMeta(runtimeRaw)).toBe(false);
			expect(JSON.parse(runtimeRaw).version).toBe(1);

			// After the orchestrator write, the manager meta must remain valid.
			expect(isValidSessionMeta(readFileSync(metaFile, "utf-8"))).toBe(true);
		}

		// The two sidecars must never hold identical content.
		expect(readFileSync(metaFile, "utf-8")).not.toBe(readFileSync(runtimeMetaFile, "utf-8"));
	});
});
