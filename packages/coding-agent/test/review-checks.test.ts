/**
 * Tests for review check discovery and the code_review tool.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECK_BASELINE_TOOLS, loadReviewChecks, resolveCheckTools } from "../src/core/review-checks.ts";
import { createCodeReviewToolDefinition } from "../src/core/tools/code-review.ts";

describe("loadReviewChecks", () => {
	let tempDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `checks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers checks from .agents/checks with frontmatter", () => {
		const checksDir = join(cwd, ".agents", "checks");
		mkdirSync(checksDir, { recursive: true });
		writeFileSync(
			join(checksDir, "no-any.md"),
			`---
name: no-any
description: Disallow the any type
severity-default: high
tools:
  - read
  - grep
---
Look for usages of the \`any\` type and report them.`,
		);

		const { checks, diagnostics } = loadReviewChecks({ cwd });
		expect(diagnostics).toEqual([]);
		expect(checks).toHaveLength(1);
		expect(checks[0].name).toBe("no-any");
		expect(checks[0].description).toBe("Disallow the any type");
		expect(checks[0].severityDefault).toBe("high");
		expect(checks[0].tools).toEqual(["read", "grep"]);
		expect(checks[0].instructions).toContain("any");
	});

	it("falls back to a filename slug when name is missing", () => {
		const checksDir = join(cwd, ".agents", "checks");
		mkdirSync(checksDir, { recursive: true });
		writeFileSync(join(checksDir, "no-console-log.md"), `---\ndescription: x\n---\nbody`);

		const { checks } = loadReviewChecks({ cwd });
		expect(checks[0].name).toBe("no-console-log");
	});

	it("ignores invalid severity values", () => {
		const checksDir = join(cwd, ".agents", "checks");
		mkdirSync(checksDir, { recursive: true });
		writeFileSync(
			join(checksDir, "bad-sev.md"),
			`---
name: bad-sev
severity-default: bananas
---
body`,
		);

		const { checks } = loadReviewChecks({ cwd });
		expect(checks[0].severityDefault).toBeUndefined();
	});

	it("returns empty checks when none exist", () => {
		const { checks } = loadReviewChecks({ cwd });
		expect(checks).toEqual([]);
	});

	it("dedupes by name keeping the most specific (nearest) source", () => {
		// Outer project checks dir (ancestor) plus inner (cwd).
		const outerChecks = join(tempDir, ".agents", "checks");
		mkdirSync(outerChecks, { recursive: true });
		writeFileSync(
			join(outerChecks, "shared.md"),
			`---
name: shared
description: outer version
---
outer body`,
		);
		const innerChecks = join(cwd, ".agents", "checks");
		mkdirSync(innerChecks, { recursive: true });
		writeFileSync(
			join(innerChecks, "shared.md"),
			`---
name: shared
description: inner version
---
inner body`,
		);

		const { checks } = loadReviewChecks({ cwd });
		const shared = checks.find((c) => c.name === "shared");
		expect(shared?.description).toBe("inner version");
		expect(shared?.instructions).toBe("inner body");
	});

	it("only loads .md files", () => {
		const checksDir = join(cwd, ".agents", "checks");
		mkdirSync(checksDir, { recursive: true });
		writeFileSync(join(checksDir, "README.txt"), "not a check");
		writeFileSync(
			join(checksDir, "real.md"),
			`---
name: real
---
body`,
		);

		const { checks } = loadReviewChecks({ cwd });
		expect(checks).toHaveLength(1);
		expect(checks[0].name).toBe("real");
	});
});

describe("resolveCheckTools", () => {
	it("baseline is read-only and never includes edit/write", () => {
		expect(CHECK_BASELINE_TOOLS).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(CHECK_BASELINE_TOOLS).not.toContain("edit");
		expect(CHECK_BASELINE_TOOLS).not.toContain("write");
	});

	it("includes baseline plus declared tools intersected with available", () => {
		const tools = resolveCheckTools({ name: "x", tools: ["read", "grep", "custom"], instructions: "", path: "" }, [
			"read",
			"grep",
			"find",
			"ls",
			"bash",
			"custom",
		]);
		// baseline (read, grep, find, ls, bash) + custom, all available
		expect(tools).toContain("read");
		expect(tools).toContain("custom");
		expect(tools).not.toContain("edit");
	});

	it("drops tools not available to the caller", () => {
		const tools = resolveCheckTools({ name: "x", tools: ["read", "secret"], instructions: "", path: "" }, [
			"read",
			"grep",
			"find",
			"ls",
			"bash",
		]);
		expect(tools).not.toContain("secret");
	});
});

describe("code_review tool", () => {
	const registrations: Array<() => void> = [];

	afterEach(() => {
		for (const unregister of registrations) {
			unregister();
		}
		registrations.length = 0;
	});

	it("runs a check subagent and aggregates structured findings", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());

		// Subagent returns a JSON array of findings.
		const findingsJson = JSON.stringify([
			{
				file: "src/a.ts",
				line: 10,
				severity: "high",
				problem: "uses any",
				why: "loses type safety",
				fix: "use unknown",
			},
		]);
		faux.setResponses([fauxAssistantMessage(findingsJson)]);

		const result = await createCodeReviewToolDefinition({
			cwd: process.cwd(),
			model: faux.getModel(),
			tools: [],
			delegatableToolNames: [],
			checks: [
				{
					name: "no-any",
					description: "Disallow any",
					severityDefault: "high",
					tools: [],
					instructions: "Find any usages.",
					path: "<test>",
				},
			],
		}).execute("id1", { diff: "--- a\n+++ b\n+let x: any" }, undefined, undefined, {} as never);

		const text = (result.content[0] as { text?: string }).text ?? "";
		expect(text).toContain("no-any");
		expect(text).toContain("uses any");
		expect(text).toContain("1 finding");
		expect(result.details).toMatchObject({ results: [{ name: "no-any" }] });
	});

	it("reports no findings cleanly", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("[]")]);

		const result = await createCodeReviewToolDefinition({
			cwd: process.cwd(),
			model: faux.getModel(),
			tools: [],
			delegatableToolNames: [],
			checks: [{ name: "ok", tools: [], instructions: "", path: "" }],
		}).execute("id1", { paths: ["src/a.ts"] }, undefined, undefined, {} as never);

		const text = (result.content[0] as { text?: string }).text ?? "";
		expect(text).toContain("0 finding");
	});

	it("errors when neither diff nor paths are given", async () => {
		const result = await createCodeReviewToolDefinition({
			cwd: process.cwd(),
			model: () => undefined,
			tools: [],
			delegatableToolNames: [],
			checks: [],
		}).execute("id1", {}, undefined, undefined, {} as never);

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("provide a diff") });
	});

	it("reports when no checks are configured", async () => {
		const result = await createCodeReviewToolDefinition({
			cwd: process.cwd(),
			model: () => undefined,
			tools: [],
			delegatableToolNames: [],
			checks: [],
		}).execute("id1", { diff: "x" }, undefined, undefined, {} as never);

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("No review checks") });
	});
});
