import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function tmpCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "piki-session-leaf-"));
	tempDirs.push(dir);
	return dir;
}

describe("SessionManager branch leaf persistence", () => {
	it("restores a branched leaf across restart", () => {
		const cwd = tmpCwd();
		const sm = SessionManager.create(cwd);

		const id1 = sm.appendMessage(userMsg("first"));
		sm.appendMessage(userMsg("second"));
		sm.appendMessage(userMsg("third"));

		// Branch back to the first entry and continue.
		sm.branch(id1);
		const branchId = sm.appendMessage(userMsg("branch child"));
		expect(sm.getLeafId()).toBe(branchId);

		const sessionFile = sm.getSessionFile()!;

		// Resume the session from disk; leaf must be the branched entry,
		// not the last physical entry ("third").
		const reopened = SessionManager.open(sessionFile);
		expect(reopened.getLeafId()).toBe(branchId);
		expect(reopened.getLeafId()).not.toBe(id1);
	});

	it("persists and restores resetLeaf() to default", () => {
		const cwd = tmpCwd();
		const sm = SessionManager.create(cwd);
		sm.appendMessage(userMsg("a"));
		const bId = sm.appendMessage(userMsg("b"));

		sm.resetLeaf();
		expect(sm.getLeafId()).toBeNull();

		const sessionFile = sm.getSessionFile()!;
		const reopened = SessionManager.open(sessionFile);
		// Persisted leafId: null means "default" (last physical entry) on resume.
		expect(reopened.getLeafId()).toBe(bId);
	});

	it("falls back to default when persisted leaf no longer resolves", () => {
		const cwd = tmpCwd();
		const sm = SessionManager.create(cwd);
		sm.appendMessage(userMsg("a"));
		sm.appendMessage(userMsg("b"));
		const sessionFile = sm.getSessionFile()!;

		// Write a sidecar meta whose leafId points to a missing entry.
		const metaPath = `${sessionFile.slice(0, -".jsonl".length)}.meta.json`;
		expect(existsSync(metaPath)).toBe(true);
		const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
		meta.leafId = "does-not-exist";
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));

		// Resume must ignore the unresolved leaf and land on the last physical entry.
		const reopened = SessionManager.open(sessionFile);
		expect(reopened.getLeafId()).not.toBe("does-not-exist");
		expect(reopened.getLeafId()).not.toBeNull();
	});
});
