import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionRuntimeServices } from "../src/core/session-runtime-services.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("session runtime services", () => {
	it("creates session-scoped services and saves tool result sidecars", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piki-runtime-services-"));
		tempDirs.push(cwd);
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const services = createSessionRuntimeServices({
			cwd,
			sessionId: "session-1",
			publishRuntimeEvent: (type, payload) => {
				events.push({ type, payload });
			},
		});

		const path = Effect.runSync(
			services.saveToolResultSidecar({
				toolCallId: "toolu-1",
				toolName: "bash",
				args: { command: "echo ok" },
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			}),
		);
		await Effect.runPromise(services.publishRuntimeEvent("runtime.test", { ok: true }));

		expect(path).toContain(join(".piki", "scratchpad", "results"));
		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			metadata: { sessionId?: string; toolCallId?: string; toolName?: string };
			data: { toolCallId?: string; toolName?: string };
		};
		expect(parsed.metadata.sessionId).toBe("session-1");
		expect(parsed.metadata.toolCallId).toBe("toolu-1");
		expect(parsed.data.toolName).toBe("bash");
		expect(events).toEqual([{ type: "runtime.test", payload: { ok: true } }]);
	});
});
