/**
 * S7 — Tool structured-output `details` (P3 grep/tree + P5 web_search).
 *
 * These are INTENTIONAL-DIVERGENCE tests: piki keeps the model-visible `content`
 * as plain text (a defensible product divergence from mag, which returns the
 * structured array AS the tool result) and ALSO exposes a structured `details`
 * channel (`details.matches` / `details.entries` / `details.sources`) mirroring
 * mag's shapes for programmatic consumers.
 *
 * Tests assert the `details` shapes are present and correctly typed. They do NOT
 * assert that `content` becomes an array (that would be Option A, out of scope).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@piki/agent-core";
import type { TextContent } from "@piki/ai";
import { afterAll, describe, expect, it } from "vitest";
import { createGrepTool } from "../../../src/core/tools/grep.ts";
import { createTreeTool } from "../../../src/core/tools/tree.ts";
import { createWebSearchToolDefinition } from "../../../src/core/tools/web-search.ts";

const tmpRoots: string[] = [];
function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpRoots.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tmpRoots) {
		try {
			require("node:fs").rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup failures
		}
	}
});

function textOf(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	if (first && first.type === "text") return (first as TextContent).text ?? "";
	return "";
}

describe("P3 — grep structured details.matches (intentional divergence)", () => {
	it("populates details.matches mirroring mag SearchMatch { file, match }", async () => {
		const dir = makeTempDir("s7-grep-");
		writeFileSync(join(dir, "a.ts"), "const alpha = 1;\nconst beta = 2;\n");
		writeFileSync(join(dir, "b.ts"), "const alpha = 3;\n");

		const tool = createGrepTool(dir);
		const result = await tool.execute("call-1", { pattern: "alpha", path: dir, limit: 50 });

		expect(result.content[0]?.type).toBe("text");
		expect(typeof textOf(result)).toBe("string");

		const details = result.details as { matches?: Array<{ file: string; match: string }> } | undefined;
		expect(details?.matches).toBeDefined();
		expect(Array.isArray(details?.matches)).toBe(true);

		const matches = details!.matches!;
		expect(matches.length).toBe(2);
		for (const m of matches) {
			expect(typeof m.file).toBe("string");
			// mag format is "<lineNum>|<lineText>"
			expect(m.match).toMatch(/^\d+\|/);
		}
		// both matches reference the searched pattern on their line
		expect(matches.every((m) => m.match.includes("alpha"))).toBe(true);
	});

	it("omits details.matches when there are no matches", async () => {
		const dir = makeTempDir("s7-grep-");
		writeFileSync(join(dir, "a.ts"), "nothing here\n");

		const tool = createGrepTool(dir);
		const result = await tool.execute("call-2", { pattern: "zzz_no_such_pattern_zzz", path: dir });
		const details = result.details as { matches?: unknown } | undefined;
		expect(details?.matches).toBeUndefined();
	});
});

describe("P3 — tree structured details.entries (intentional divergence)", () => {
	it("populates details.entries mirroring mag TreeEntry { path, name, type, depth }", async () => {
		const dir = makeTempDir("s7-tree-");
		writeFileSync(join(dir, "root.txt"), "x");
		// create a subdirectory + nested file
		const sub = join(dir, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "nested.txt"), "y");

		const tool = createTreeTool(dir);
		const result = await tool.execute("call-3", { path: dir, recursive: true }, undefined, undefined);

		expect(result.content[0]?.type).toBe("text");
		expect(typeof textOf(result)).toBe("string");

		const details = result.details as
			| {
					entries?: Array<{ path: string; name: string; type: "file" | "dir"; depth: number }>;
			  }
			| undefined;
		expect(details?.entries).toBeDefined();
		expect(Array.isArray(details?.entries)).toBe(true);

		const entries = details!.entries!;
		expect(entries.length).toBeGreaterThanOrEqual(2);
		for (const e of entries) {
			expect(typeof e.path).toBe("string");
			expect(typeof e.name).toBe("string");
			expect(e.type === "file" || e.type === "dir").toBe(true);
			expect(typeof e.depth).toBe("number");
		}
		// nested entry must reflect a subdirectory traversal (depth >= 1)
		expect(entries.some((e) => e.type === "dir" && e.depth >= 1)).toBe(true);
	});
});

describe("P5 — web_search structured details.sources (intentional divergence)", () => {
	it("populates details.sources mirroring mag { title, url }[]", async () => {
		const fakeHtml = `
			<div class="result results_links web-result">
				<a class="result__a" href="https://example.com/one">One</a>
				<a class="result__url" href="https://example.com/one">https://example.com/one</a>
				<a class="result__snippet">first snippet</a>
			</div>
			<div class="result results_links results_links_deep web-result">
				<a class="result__a" href="https://example.com/two">Two</a>
				<a class="result__url" href="https://example.com/two">https://example.com/two</a>
				<a class="result__snippet">second snippet</a>
			</div>`;

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			text: async () => fakeHtml,
		})) as unknown as typeof fetch;

		try {
			const tool = createWebSearchToolDefinition();
			const result = await tool.execute(
				"call-4",
				{ query: "test query", maxResults: 10 },
				undefined,
				undefined,
				{} as never,
			);

			expect(result.content[0]?.type).toBe("text");
			const details = result.details as
				| {
						sources?: Array<{ title: string; url: string }>;
						results?: unknown;
				  }
				| undefined;
			expect(details?.sources).toBeDefined();
			expect(Array.isArray(details?.sources)).toBe(true);

			const sources = details!.sources!;
			expect(sources.length).toBe(2);
			expect(sources[0]).toEqual({ title: "One", url: "https://example.com/one" });
			expect(sources[1]).toEqual({ title: "Two", url: "https://example.com/two" });

			// piki retains the full results (with snippets) as a superset of mag's sources.
			expect(Array.isArray(details?.results)).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("S11 — web_search optional schema input + data output (mag parity)", () => {
	it("declares an optional `schema` parameter matching mag's Record(String, Unknown)", () => {
		const tool = createWebSearchToolDefinition();
		const schema = tool.parameters;
		// mag: schema: optional(Record(String, Unknown))
		expect(schema).toBeDefined();
		const props = (schema as { properties?: Record<string, unknown> }).properties;
		expect(props).toBeDefined();
		expect(props!.schema).toBeDefined();
		const schemaProp = props!.schema as { type?: string; optional?: boolean };
		// typebox Optional wraps the inner type; presence of the key is the contract point.
		expect(schemaProp).toHaveProperty("type");
	});

	it("returns `data: undefined` in details for both empty and populated result branches", async () => {
		const originalFetch = globalThis.fetch;

		// Empty-results branch.
		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			text: async () => "<html></html>",
		})) as unknown as typeof fetch;
		try {
			const empty = await createWebSearchToolDefinition().execute(
				"call-empty",
				{ query: "nothing", schema: { foo: "bar" } },
				undefined,
				undefined,
				{} as never,
			);
			expect((empty.details as { data?: unknown }).data).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}

		// Populated-results branch.
		const fakeHtml = `
			<div class="result results_links web-result">
				<a class="result__a" href="https://example.com/one">One</a>
				<a class="result__url" href="https://example.com/one">https://example.com/one</a>
				<a class="result__snippet">first snippet</a>
			</div>`;
		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			text: async () => fakeHtml,
		})) as unknown as typeof fetch;
		try {
			const populated = await createWebSearchToolDefinition().execute(
				"call-pop",
				{ query: "test", schema: { foo: "bar" } },
				undefined,
				undefined,
				{} as never,
			);
			expect((populated.details as { data?: unknown }).data).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
