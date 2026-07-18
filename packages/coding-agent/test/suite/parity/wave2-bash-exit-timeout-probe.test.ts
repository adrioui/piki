import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../../../src/core/tools/index.ts";
import { getTextOutput } from "../../../src/core/tools/render-utils.ts";

/**
 * Wave-2 Scientist probe (sci-tools-wave2): verify piki's OBSERVABLE model-visible
 * behavior for non-zero exits and timeouts, and compare intent vs Magnitude alpha22.
 *
 * Mag (packages/agent/src/models/shell.ts + shellTool definition + renderToolOutput):
 *   completed result = { mode: "completed", stdout, stderr, exitCode }
 *   renderToolOutput serializes EVERY field to `<field>value</field>` tags.
 *   So the model sees stdout, stderr AND exitCode in the result text.
 *
 * Piki: bash tool returns { content:[{type:"text", text}], details:{exitCode} }.
 * `details` is never serialized into model-visible text (createToolResultMessage
 * keeps content and details separate; convertToLlm passes toolResult through as-is).
 */

function _countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("bash tool observable output shape vs mag", () => {
	it("non-zero exit: model-visible text contains stdout but NOT exitCode tag", async () => {
		const bash = createBashToolDefinition(process.cwd());
		const result = await bash.execute(
			"call-1",
			{ command: "echo hello-out; echo hello-err >&2; exit 7" },
			undefined as never,
			undefined as never,
			undefined as never,
		);
		const text = getTextOutput(result, false);

		// stdout and stderr are both present (combined into one text block).
		expect(text).toContain("hello-out");
		expect(text).toContain("hello-err");

		// F2 fix: mag renders `<exitCode>7</exitCode>` into the model text. piki
		// appends a `exit_code: 7` footer to the model-visible text so the model
		// can observe the non-zero exit without throwing.
		expect(text).toContain("exit_code: 7");
		expect(result.details?.exitCode).toBe(7);

		// Divergence retained as intentional (out of scope): piki does not tag
		// stderr/stdout separately; mag shows <stderr>...</stderr> / <stdout>.
		expect(text).not.toContain("<stderr>");
		expect(text).not.toContain("<stdout>");
	});

	it("non-zero exit is a COMPLETED (non-error) result, not a thrown error", async () => {
		const bash = createBashToolDefinition(process.cwd());
		const result = await bash.execute(
			"call-2",
			{ command: "exit 1" },
			undefined as never,
			undefined as never,
			undefined as never,
		);
		// Did not throw; result delivered with exitCode in details.
		expect(result.details?.exitCode).toBe(1);
		// isError flag is not set on the result payload here (details only).
		expect(result.content).toBeDefined();
	});

	it("timeout: throws an Error (not a completed result carrying a timeout field)", async () => {
		const bash = createBashToolDefinition(process.cwd());
		// mag has no `timeout` param on shell at all; the equivalent is detach_after.
		// piki DOES have a `timeout` param and throws on expiry.
		await expect(
			bash.execute(
				"call-3",
				{ command: "sleep 5", timeout: 1 },
				undefined as never,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(/timed out/i);
	});

	it("bash schema includes `timeout` (piki superset); mag shell uses detach_after instead", async () => {
		const bash = createBashToolDefinition(process.cwd());
		const props = (bash.parameters as { properties: Record<string, unknown> }).properties;
		expect(props).toHaveProperty("timeout");
		expect(Object.keys(props).sort()).toEqual(["command", "timeout"]);
	});

	it("shell schema mirrors mag: command + detach_after, no timeout", async () => {
		const { createShellToolDefinition } = await import("../../../src/core/tools/index.ts");
		const shell = createShellToolDefinition(process.cwd());
		const props = (shell.parameters as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(props).sort()).toEqual(["command", "detach_after"]);
	});
});

describe("bash output formatting: truncation banner parity", () => {
	it("large output gets a truncation banner with full-output path (matches mag intention)", async () => {
		const _bash = createBashToolDefinition(process.cwd());
		const manyLines: string[] = [];
		for (let i = 1; i <= 3000; i++) manyLines.push(`line ${i}`);
		const operations = {
			exec: async (_command: string, _cwd: string, opts: { onData: (d: Buffer) => void }) => {
				opts.onData(Buffer.from(`${manyLines.join("\n")}\n`));
				return { exitCode: 0 };
			},
		};
		const { createBashTool } = await import("../../../src/core/tools/index.ts");
		const bashTool = createBashTool(process.cwd(), { operations });
		const result = await bashTool.execute("call-4", { command: "big" }, undefined as never, undefined as never);
		const text = getTextOutput(result, false);
		expect(text).toContain("Truncated");
		// Banner references a full-output path for recovery.
		expect(text).toMatch(/Full output:/);
		// Should NOT contain the timeout/abort error text.
		expect(text).not.toContain("timed out");
	});
});
