import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScratchpadManager } from "../src/core/scratchpad-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("ScratchpadManager", () => {
	it("saves JSON tool results under results with metadata", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "piki-scratchpad-"));
		tempDirs.push(rootDir);
		const scratchpad = new ScratchpadManager({ rootDir });
		scratchpad.setSessionId("session-1");

		const path = scratchpad.saveJsonResult("bash-toolu-1", { stdout: "ok" }, { toolCallId: "toolu-1" });

		expect(path).toMatch(/results\/\d+-bash-toolu-1\.json$/);
		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			metadata: { sessionId?: string; toolCallId?: string };
			data: { stdout?: string };
		};
		expect(parsed.metadata.sessionId).toBe("session-1");
		expect(parsed.metadata.toolCallId).toBe("toolu-1");
		expect(parsed.data.stdout).toBe("ok");
	});
});
