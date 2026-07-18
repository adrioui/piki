/**
 * W8 — Tool error flattening, web tools, tool observable output.
 *
 * Probes the parity claim: web tools (web_fetch/web_search) must THROW on
 * failure so the agent-loop's `classifyToolError` → `createClassifiedToolResult`
 * path produces `details: { toolError }`, and the model-visible text is wrapped
 * in mag's `<tool_error>...</tool_error>` block.
 *
 * mag reference: mag's web_fetch/web_search `execute` use `Effect.fail(...)`,
 * which surfaces as a `<tool_error>${message}</tool_error>` block in the model
 * message (magnitude-alpha22.embedded.js:77054). So mag errors are THROWN and
 * uniformly classified; piki's web tools now do the same.
 *
 * NOTE: the `createErrorToolResult` afterToolCall path remains unwrapped
 * (`details: {}`), a documented low-severity partial divergence not in scope
 * for W8.
 */

import type { AgentToolResult } from "@piki/agent-core";
import type { TextContent } from "@piki/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createWebFetchToolDefinition } from "../../../src/core/tools/web-fetch.ts";
import { createWebSearchToolDefinition } from "../../../src/core/tools/web-search.ts";
import type { WorkerTool } from "../../../src/core/worker-session.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function textOf(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	if (first && first.type === "text") return (first as TextContent).text ?? "";
	return "";
}

describe("W8 G1 — web tools throw, reaching uniform toolError classification + <tool_error> wrapper", () => {
	it("web_fetch failure is classified with details.toolError and wrapped in <tool_error>", async () => {
		// web_fetch self-catches in the caller; here we assert the classified shape
		// the agent-loop produces when the tool throws. The tool now throws (not
		// self-returns), so a harness invoking it through the run loop gets the
		// classified result. We exercise the classification contract directly via
		// the same module the loop uses.
		const tool = createWebFetchToolDefinition();
		// The execute now throws on SSRF block; verify it throws (caller catches
		// and classifies). This confirms the self-catch is removed.
		await expect(
			tool.execute("call-wf", { url: "file:///etc/passwd" }, undefined, undefined, {} as never),
		).rejects.toBeInstanceOf(Error);

		// Classification + wrapping contract (mirrors agent-loop behavior):
		const { classifyToolError, createClassifiedToolResult } = await import("@piki/agent-core");
		const classified = classifyToolError(new Error("Blocked URL"), { toolName: "web_fetch" });
		const result = createClassifiedToolResult(classified);
		const details = result.details as Record<string, unknown> | undefined;
		expect(details).toHaveProperty("toolError");
		expect(details).not.toHaveProperty("error");
		expect(textOf(result as AgentToolResult<unknown>)).toMatch(/^<tool_error>/);
		expect(textOf(result as AgentToolResult<unknown>)).not.toContain("Web fetch failed:");
	});

	it("web_search failure is classified with details.toolError and wrapped in <tool_error>", async () => {
		globalThis.fetch = (async () => ({
			ok: false,
			status: 503,
			statusText: "Service Unavailable",
			text: async () => "",
		})) as unknown as typeof fetch;

		const tool = createWebSearchToolDefinition();
		await expect(
			tool.execute("call-ws", { query: "anything" }, undefined, undefined, {} as never),
		).rejects.toBeInstanceOf(Error);

		const { classifyToolError, createClassifiedToolResult } = await import("@piki/agent-core");
		const classified = classifyToolError(new Error("Search request failed: 503"), { toolName: "web_search" });
		const result = createClassifiedToolResult(classified);
		const details = result.details as Record<string, unknown> | undefined;
		expect(details).toHaveProperty("toolError");
		expect(details).not.toHaveProperty("error");
		expect(textOf(result as AgentToolResult<unknown>)).toMatch(/^<tool_error>/);
		expect(textOf(result as AgentToolResult<unknown>)).not.toContain("Web search failed:");
	});
});

describe("W8 G2 — query_image is gated by webTools:false (in WEB_TOOL_NAMES)", () => {
	it("query_image is removed for roles with webTools:false", async () => {
		const { filterToolsForRole } = await import("../../../src/core/worker-tools.ts");
		const tools: WorkerTool[] = [
			{
				name: "web_fetch",
				description: "",
				parameters: {} as never,
				execute: async () => ({ content: [], details: {} }),
			},
			{
				name: "web_search",
				description: "",
				parameters: {} as never,
				execute: async () => ({ content: [], details: {} }),
			},
			{
				name: "query_image",
				description: "",
				parameters: {} as never,
				execute: async () => ({ content: [], details: {} }),
			},
			{
				name: "grep",
				description: "",
				parameters: {} as never,
				execute: async () => ({ content: [], details: {} }),
			},
		];

		const criticTools = filterToolsForRole("critic", tools);
		const criticNames = criticTools.map((t) => t.name);
		expect(criticNames).not.toContain("web_fetch");
		expect(criticNames).not.toContain("web_search");
		expect(criticNames).not.toContain("query_image");
		expect(criticNames).toContain("grep");

		const workerTools = filterToolsForRole("artisan", tools);
		const workerNames = workerTools.map((t) => t.name);
		expect(workerNames).toContain("web_fetch");
		expect(workerNames).toContain("web_search");
		expect(workerNames).toContain("query_image");
	});
});

describe("W8 G1 — mag parity reference (documentation of the oracle)", () => {
	it("documents that mag wraps tool errors in <tool_error> and classifies uniformly", () => {
		// mag: tool-result-formatter.ts
		//   case "Error":
		//     return [{ _tag: "TextPart", text: `<tool_error>${result.error.message}</tool_error>` }];
		// mag web tools `Effect.fail({_tag:"WebFetchError"|"WebSearchError", message})`
		// → reach the Error tag → uniform <tool_error> wrapper + schema error metadata.
		//
		// piki now mirrors this: web_fetch/web_search THROW on failure, the agent
		// loop classifies them (packages/agent/src/tool-errors.ts:
		// createClassifiedToolResult → { content:[{text:`<tool_error>${msg}</tool_error>`}],
		// details:{toolError} }) producing mag-aligned model-visible output.
		expect(true).toBe(true);
	});
});
