/**
 * S11 Fix 1 — shell `M` env must resolve to the session scratchpadPath
 * (mag sets `M: scratchpadPath`), not the outer `process.env.M`.
 *
 * The fix threads `scratchpadPath` through BashToolOptions → resolveSpawnContext
 * / spawnDetached / executeBashWithOperations. This regression proves the
 * session-injected value reaches the spawned shell env.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";

describe("S11 — shell M env uses session scratchpadPath", () => {
	const originals: Record<string, string | undefined> = {};
	afterEach(() => {
		for (const [k, v] of Object.entries(originals)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	const setProcessEnvM = (value: string | undefined) => {
		originals.M = process.env.M;
		if (value === undefined) delete process.env.M;
		else process.env.M = value;
	};

	it("resolveSpawnContext sets M to scratchpadPath when provided (via spawnHook capture)", async () => {
		setProcessEnvM("/outer/env/M");
		const captured: Array<string | undefined> = [];
		const def = createBashToolDefinition("/cwd", {
			scratchpadPath: "/x/scratch",
			spawnHook: (ctx) => {
				captured.push(ctx.env.M);
				// Short-circuit execution so we don't actually spawn a process.
				throw Object.assign(new Error("captured"), { __captured: true });
			},
		});
		try {
			await def.execute("call-1", { command: "echo $M" }, undefined, undefined, {} as never);
		} catch (err) {
			if (!(err instanceof Error && (err as { __captured?: boolean }).__captured)) throw err;
		}
		expect(captured[0]).toBe("/x/scratch");
	});

	it("falls back to process.env.M when scratchpadPath is absent", async () => {
		setProcessEnvM("/outer/env/M");
		const captured: Array<string | undefined> = [];
		const def = createBashToolDefinition("/cwd", {
			spawnHook: (ctx) => {
				captured.push(ctx.env.M);
				throw Object.assign(new Error("captured"), { __captured: true });
			},
		});
		try {
			await def.execute("call-2", { command: "echo $M" }, undefined, undefined, {} as never);
		} catch (err) {
			if (!(err instanceof Error && (err as { __captured?: boolean }).__captured)) throw err;
		}
		expect(captured[0]).toBe("/outer/env/M");
	});
});
