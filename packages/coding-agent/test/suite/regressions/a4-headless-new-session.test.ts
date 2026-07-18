import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Regression for A4: a new session started in non-interactive mode (print/json)
 * without any initial prompt, trailing message, or --goal must fail fast with
 * exit 1 and a clear error — mirroring mag's `--headless` new-session guard.
 *
 * Driven through the real `main()` entry point (via tsx) so the guard lives on
 * the actual dispatch path. No real provider/network is reached: the positive
 * case exits at the guard, and the negative controls are pushed past the guard
 * into a fast local "unknown provider" failure (still no network).
 */

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..", "..");

const childScript = `
import { writeFileSync } from "node:fs";
import { registerFauxProvider } from "${join(repoRoot, "packages/ai/src/compat.ts")}";
import { main } from "${join(repoRoot, "packages/coding-agent/src/main.ts")}";

registerFauxProvider({ models: [{ id: "faux-1" }] });
const argv = JSON.parse(process.env.A4_ARGV || "[]");
const resultPath = process.env.A4_RESULT;
let exitCode = 0;
process.exit = ((code) => { exitCode = code ?? 0; throw new Error("__A4_EXIT__:" + exitCode); }) ;
try {
  await main(argv);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.startsWith("__A4_EXIT__")) throw e;
}
try { writeFileSync(resultPath, String(exitCode)); } catch {}
`;

let tempDir = "";
let childPath = "";
let resultPath = "";

afterAll(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function runMain(argv: string[]): Promise<{ code: number; stderr: string; guardTriggered: boolean }> {
	if (!tempDir) {
		tempDir = mkdtempSync(join(tmpdir(), "piki-a4-"));
		childPath = join(tempDir, "child.mts");
		resultPath = join(tempDir, "result.txt");
		writeFileSync(childPath, childScript);
	}
	return new Promise((resolve, reject) => {
		const tsx = join(repoRoot, "node_modules/.bin/tsx");
		const child = spawn(tsx, [childPath], {
			env: { ...process.env, A4_ARGV: JSON.stringify(argv), A4_RESULT: resultPath, PIKI_OFFLINE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60000,
		});
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			let rc = code ?? -1;
			try {
				const written = readFileSync(resultPath, "utf-8").trim();
				if (written !== "") rc = Number(written);
			} catch {
				// fall back to the process close code
			}
			resolve({
				code: rc,
				stderr,
				guardTriggered: stderr.includes("new non-interactive session requires"),
			});
		});
	});
}

describe("A4: new non-interactive session requires a prompt or --goal", () => {
	it("exits 1 with a clear error when a new non-interactive session has no prompt/goal", async () => {
		const result = await runMain(["--mode", "json"]);
		expect(result.guardTriggered).toBe(true);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("a new non-interactive session requires a prompt");
	});

	it("does not trigger the guard when an initial prompt is supplied", async () => {
		const result = await runMain(["--mode", "json", "--provider", "faux", "--model", "faux/faux-1", "-p", "hello"]);
		expect(result.guardTriggered).toBe(false);
	});

	it("does not trigger the guard when --goal is supplied", async () => {
		const result = await runMain([
			"--mode",
			"json",
			"--provider",
			"faux",
			"--model",
			"faux/faux-1",
			"--goal",
			"do the thing",
		]);
		expect(result.guardTriggered).toBe(false);
	});

	it("does not trigger the guard when --continue is supplied", async () => {
		const result = await runMain(["--mode", "json", "--provider", "faux", "--model", "faux/faux-1", "--continue"]);
		expect(result.guardTriggered).toBe(false);
	});
});
