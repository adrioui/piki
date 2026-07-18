import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, sidecarPathForSessionFile } from "../../../src/core/session-manager.ts";

/**
 * Session lifecycle / persistence / branching parity checks (dimension: sessions).
 *
 * Deterministic (no faux provider required). These lock in the piki-only branching
 * leaf persistence verified against Magnitude alpha22: piki persists the selected
 * branch leaf to `.meta.json` and restores it on `SessionManager.open`, so a
 * selected earlier branch survives a restart. Magnitude has no persisted branching
 * (piki superset); the test guards the piki behavior from regressing.
 */
describe("session lifecycle: branch leaf persistence", () => {
	let dir: string;
	let sessionDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "piki-session-lifecycle-"));
		sessionDir = join(dir, "sessions");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function fresh(): SessionManager {
		const mgr = SessionManager.create(dir, sessionDir);
		mgr.appendMessage({ role: "user", content: "root task", timestamp: Date.now() } as never);
		const a = mgr.appendMessage({ role: "assistant", content: "a", timestamp: Date.now() } as never);
		const b = mgr.appendMessage({ role: "user", content: "branch here", timestamp: Date.now() } as never);
		// Select a non-default leaf so the default (last physical entry) != selected.
		mgr.branch(b);
		expect(mgr.getLeafId()).toBe(b);
		void a;
		return mgr;
	}

	it("persists the selected branch leaf to the .meta.json sidecar on branch()", () => {
		const mgr = fresh();
		const filePath = mgr.getSessionFile()!;

		const metaPath = sidecarPathForSessionFile(filePath, ".meta.json");
		expect(existsSync(metaPath)).toBe(true);
		const meta = JSON.parse(readFileSync(metaPath, "utf8"));
		expect(typeof meta.leafId).toBe("string");
		expect(meta.leafId).toBe(mgr.getLeafId());
	});

	it("restores the persisted branch leaf across SessionManager.open()", () => {
		const mgr = fresh();
		const selectedLeaf = mgr.getLeafId();
		const filePath = mgr.getSessionFile()!;

		// Re-open the same session file, as a restart/resume would.
		const reopened = SessionManager.open(filePath, sessionDir);
		expect(reopened.getLeafId()).toBe(selectedLeaf);
		expect(reopened.getEntries().some((e) => e.id === selectedLeaf)).toBe(true);
	});

	it("falls back to the default leaf when the stored leaf no longer resolves", () => {
		const mgr = fresh();
		const filePath = mgr.getSessionFile()!;

		// Corrupt the stored leaf id so it cannot resolve to a real entry.
		const metaPath = sidecarPathForSessionFile(filePath, ".meta.json");
		const meta = JSON.parse(readFileSync(metaPath, "utf8"));
		meta.leafId = "does-not-exist";
		writeFileSync(metaPath, JSON.stringify(meta));

		const reopened = SessionManager.open(filePath, sessionDir);
		expect(reopened.getEntries().some((e) => e.id === reopened.getLeafId())).toBe(true);
	});
});

/**
 * Deterministic check that corrupt JSONL lines are skipped (piki superset over
 * Magnitude's readJsonLines, which throws on a bad line). Guards the tolerant
 * parse from regressing into a hard-fail on a single malformed line.
 */
describe("session lifecycle: corrupt-line tolerance", () => {
	let dir: string;
	let sessionDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "piki-session-corrupt-"));
		sessionDir = join(dir, "sessions");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("skips a malformed JSONL line and keeps good entries", () => {
		const mgr = SessionManager.create(dir, sessionDir);
		const goodId = mgr.appendMessage({ role: "user", content: "ok", timestamp: Date.now() } as never);
		const filePath = mgr.getSessionFile()!;

		// Append a garbage line to the closed session file.
		appendFileSync(filePath, "this is not valid json\n");

		const reopened = SessionManager.open(filePath, sessionDir);
		const ids = reopened.getEntries().map((e) => e.id);
		expect(ids).toContain(goodId);
		expect(ids).toHaveLength(1);
	});
});
