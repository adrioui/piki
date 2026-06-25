/**
 * Tests for AGENTS.md @file includes and glob-scoped guidance.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	expandAtFileIncludes,
	extractAtMentions,
	filterGlobScopedDocs,
	parseGlobScopedDoc,
	stripFencedCodeBlocks,
} from "../src/core/context-includes.ts";
import { loadProjectContextFiles } from "../src/core/resource-loader.ts";

describe("stripFencedCodeBlocks", () => {
	it("removes triple-backtick fenced blocks", () => {
		const text = "before\n```bash\n@not-a-mention\n```\nafter";
		expect(stripFencedCodeBlocks(text)).not.toContain("@not-a-mention");
		expect(stripFencedCodeBlocks(text)).toContain("before");
		expect(stripFencedCodeBlocks(text)).toContain("after");
	});

	it("removes triple-tilde fenced blocks", () => {
		const text = "x\n~~~\n@hidden\n~~~\ny";
		expect(stripFencedCodeBlocks(text)).not.toContain("@hidden");
	});
});

describe("extractAtMentions", () => {
	it("ignores @mentions inside fenced code blocks", () => {
		const text = "See @docs/rules.md.\n\n```\n@ignored.md\n```";
		const mentions = extractAtMentions(text);
		expect(mentions).toContain("docs/rules.md");
		expect(mentions).not.toContain("ignored.md");
	});

	it("does not treat emails or bare @words as file paths", () => {
		const text = "Contact user@example.com or @username for help.";
		const mentions = extractAtMentions(text);
		// no path-like mentions
		expect(mentions.find((m) => m.includes("example.com"))).toBeUndefined();
	});
});

describe("expandAtFileIncludes", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `ctxinc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("inlines a directly referenced @file", () => {
		writeFileSync(join(tempDir, "extra.md"), "Extra rules go here.");
		const contextPath = join(tempDir, "AGENTS.md");
		writeFileSync(contextPath, "Project rules.\nSee @extra.md for more.");

		const result = expandAtFileIncludes(read(contextPath), contextPath);
		expect(result.content).toContain("Project rules.");
		expect(result.content).toContain("Extra rules go here.");
		expect(result.included).toHaveLength(1);
		expect(result.included[0]).toContain("extra.md");
	});

	it("resolves @file relative to the context file's directory", () => {
		const sub = join(tempDir, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "nested.md"), "nested body");
		const contextPath = join(sub, "CLAUDE.md");
		writeFileSync(contextPath, "Top. @nested.md");

		const result = expandAtFileIncludes(read(contextPath), contextPath);
		expect(result.content).toContain("nested body");
	});

	it("ignores @mentions inside fenced code blocks", () => {
		writeFileSync(join(tempDir, "code.md"), "SHOULD NOT APPEAR");
		const contextPath = join(tempDir, "AGENTS.md");
		writeFileSync(contextPath, "```\n@code.md\n```");

		const result = expandAtFileIncludes(read(contextPath), contextPath);
		expect(result.content).not.toContain("SHOULD NOT APPEAR");
		expect(result.included).toEqual([]);
	});

	it("prevents duplicate includes (each file included once)", () => {
		writeFileSync(join(tempDir, "shared.md"), "shared content");
		const contextPath = join(tempDir, "AGENTS.md");
		writeFileSync(contextPath, "First: @shared.md\nSecond: @shared.md");

		const result = expandAtFileIncludes(read(contextPath), contextPath);
		const occurrences = result.content.split("shared content").length - 1;
		expect(occurrences).toBe(1);
		expect(result.included).toHaveLength(1);
	});

	it("prevents cycles (A includes B includes A)", () => {
		writeFileSync(join(tempDir, "a.md"), "a start\n@b.md\na end");
		writeFileSync(join(tempDir, "b.md"), "b start\n@a.md\nb end");
		const contextPath = join(tempDir, "a.md");

		const result = expandAtFileIncludes(read(contextPath), contextPath);
		// Should terminate and include each file once.
		expect(result.included).toContain(join(tempDir, "b.md"));
		expect(result.warnings.length).toBeGreaterThanOrEqual(0);
	});

	it("bounds total include size", () => {
		const big = "x".repeat(5000);
		writeFileSync(join(tempDir, "big1.md"), big);
		writeFileSync(join(tempDir, "big2.md"), big);
		const contextPath = join(tempDir, "AGENTS.md");
		writeFileSync(contextPath, "@big1.md\n@big2.md");

		const result = expandAtFileIncludes(read(contextPath), contextPath, { maxIncludeBytes: 6000 });
		// Second include should be truncated/dropped due to the limit.
		expect(result.warnings.some((w) => w.includes("size limit"))).toBe(true);
		expect(result.content.length).toBeLessThanOrEqual(6000 + 200 /* headers + original */);
	});

	it("bounds a single large file", () => {
		writeFileSync(join(tempDir, "large.md"), "y".repeat(10_000));
		const contextPath = join(tempDir, "AGENTS.md");
		writeFileSync(contextPath, "@large.md");

		const result = expandAtFileIncludes(read(contextPath), contextPath, { maxFileBytes: 1000 });
		expect(result.warnings.some((w) => w.includes("truncated"))).toBe(true);
		expect(result.content).toContain("[truncated]");
	});

	it("leaves missing includes as-is with a warning", () => {
		const contextPath = join(tempDir, "AGENTS.md");
		writeFileSync(contextPath, "See @missing.md");
		const result = expandAtFileIncludes(read(contextPath), contextPath);
		expect(result.warnings.some((w) => w.includes("not found"))).toBe(true);
		expect(result.included).toEqual([]);
	});

	it("expands nested includes recursively", () => {
		writeFileSync(join(tempDir, "c.md"), "C content\n@d.md");
		writeFileSync(join(tempDir, "d.md"), "D content");
		const contextPath = join(tempDir, "AGENTS.md");
		writeFileSync(contextPath, "@c.md");

		const result = expandAtFileIncludes(read(contextPath), contextPath);
		expect(result.content).toContain("C content");
		expect(result.content).toContain("D content");
	});

	it("preserves fenced code blocks while ignoring @mentions inside them", () => {
		writeFileSync(join(tempDir, "extra.md"), "EXTRA CONTENT");
		const contextPath = join(tempDir, "AGENTS.md");
		writeFileSync(contextPath, "before\n```bash\n@extra.md\n```\nafter @extra.md");

		const result = expandAtFileIncludes(read(contextPath), contextPath);
		// Code block is preserved verbatim
		expect(result.content).toContain("```bash");
		expect(result.content).toContain("@extra.md");
		// The @extra.md outside the code block is expanded
		expect(result.content).toContain("EXTRA CONTENT");
		// Only one include (the one outside the code block)
		expect(result.included).toHaveLength(1);
	});

	it("preserves tilde fenced code blocks", () => {
		writeFileSync(join(tempDir, "rules.md"), "RULES CONTENT");
		const contextPath = join(tempDir, "AGENTS.md");
		writeFileSync(contextPath, "before\n~~~\n@rules.md\n~~~\nafter @rules.md");

		const result = expandAtFileIncludes(read(contextPath), contextPath);
		expect(result.content).toContain("~~~");
		expect(result.content).toContain("RULES CONTENT");
		expect(result.included).toHaveLength(1);
	});
});

describe("glob-scoped guidance", () => {
	it("parses globs frontmatter as conditional", () => {
		const doc = parseGlobScopedDoc(
			`---
globs:
  - "src/**/*.ts"
---
TS-specific rules`,
			"ts-rules.md",
		);
		expect(doc.alwaysInclude).toBe(false);
		expect(doc.globs).toEqual(["src/**/*.ts"]);
		expect(doc.body).toContain("TS-specific rules");
	});

	it("treats docs without globs as always-include", () => {
		const doc = parseGlobScopedDoc("plain body", "plain.md");
		expect(doc.alwaysInclude).toBe(true);
		expect(doc.globs).toEqual([]);
	});

	it("includes always-include docs regardless of touched paths", () => {
		const docs = [
			parseGlobScopedDoc("plain", "plain.md"),
			parseGlobScopedDoc(`---\nglobs: ["*.ts"]\n---\nts only`, "ts.md"),
		];
		const filtered = filterGlobScopedDocs(docs, ["README.md"]);
		expect(filtered.find((d) => d.path === "plain.md")).toBeDefined();
		expect(filtered.find((d) => d.path === "ts.md")).toBeUndefined();
	});

	it("includes glob docs when a touched path matches", () => {
		const docs = [parseGlobScopedDoc(`---\nglobs: ["src/**/*.ts"]\n---\nts rules`, "ts.md")];
		const filtered = filterGlobScopedDocs(docs, ["src/index.ts"]);
		expect(filtered.find((d) => d.path === "ts.md")).toBeDefined();
	});

	it("with no touched paths, includes only always-include docs", () => {
		const docs = [
			parseGlobScopedDoc("plain", "plain.md"),
			parseGlobScopedDoc(`---\nglobs: ["*.ts"]\n---\nts`, "ts.md"),
		];
		const filtered = filterGlobScopedDocs(docs, []);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].alwaysInclude).toBe(true);
	});
});

describe("loadProjectContextFiles @file integration", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `ctxload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("expands @file includes in discovered AGENTS.md", () => {
		writeFileSync(join(cwd, "extra.md"), "Extra inlined rule.");
		writeFileSync(join(cwd, "AGENTS.md"), "Project rules.\n@extra.md");

		const files = loadProjectContextFiles({ cwd, agentDir });
		const agents = files.find((f) => f.path.endsWith("AGENTS.md"));
		expect(agents?.content).toContain("Extra inlined rule.");
	});
});

function read(p: string): string {
	return readFileSync(p, "utf-8");
}
