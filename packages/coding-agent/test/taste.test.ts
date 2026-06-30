import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TasteProfileStore } from "../src/core/taste.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("TasteProfileStore", () => {
	it("records observations and reports status", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-taste-"));
		tempDirs.push(baseDir);
		const store = new TasteProfileStore(baseDir);

		store.recordObservation({
			timestamp: new Date().toISOString(),
			sessionId: "session-1",
			cwd: "/workspace/project",
			userText: "Prefer concise diffs",
			assistantText: "Acknowledged",
			toolNames: ["read"],
			retryCount: 0,
			stopReason: "stop",
			model: { provider: "opencode-go", id: "deepseek-v4-pro" },
			signalType: "observe",
		});

		const status = store.status("/workspace/project");
		expect(status.observationCount).toBe(1);
		expect(status.profileEntryCount).toBe(0);
	});

	it("renders only valid taste entries into the injected profile", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-taste-"));
		tempDirs.push(baseDir);
		const store = new TasteProfileStore(baseDir);
		const profilePath = store.getProfilePath("/workspace/project");
		store.ensureWorkspace("/workspace/project");
		writeFileSync(
			profilePath,
			[
				"- Be concise. Confidence: 0.91",
				"invalid line",
				"- Prefer verification before summary. Confidence: 0.77",
			].join("\n"),
		);

		const injected = store.renderInjectedProfile("/workspace/project");
		expect(injected).toContain("Be concise");
		expect(injected).not.toContain("invalid line");
		expect(readFileSync(profilePath, "utf-8")).toContain("Confidence: 0.91");
	});

	it("flags invalid lines during lint", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-taste-"));
		tempDirs.push(baseDir);
		const store = new TasteProfileStore(baseDir);
		const profilePath = store.getProfilePath("/workspace/project");
		store.ensureWorkspace("/workspace/project");
		writeFileSync(profilePath, "- valid entry. Confidence: 0.52\nnot valid\n");

		const result = store.lint("/workspace/project");
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("Invalid taste entry");
	});
});
