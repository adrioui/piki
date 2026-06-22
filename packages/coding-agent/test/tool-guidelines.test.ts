/**
 * Tests asserting Amp-quality prompt guidance exists on bash/edit/write tools.
 *
 * These assert that the key reliability guidance is present on the built tool
 * definitions so prompt regressions are caught.
 */

import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

function guidelines(def: { promptGuidelines?: string[] }): string[] {
	return def.promptGuidelines ?? [];
}

describe("bash tool prompt guidance", () => {
	const def = createBashToolDefinition(process.cwd());
	const joined = guidelines(def).join("\n");

	it("warns against interactive commands", () => {
		expect(joined).toContain("interactive");
	});

	it("prefers rg over grep/find", () => {
		expect(joined).toMatch(/rg/);
	});

	it("scopes recursive searches and excludes heavy dirs", () => {
		expect(joined).toContain("node_modules");
	});

	it("discourages cat|grep piping", () => {
		expect(joined).toContain("cat");
	});

	it("asks to quote file paths", () => {
		expect(joined).toContain("Quote");
	});

	it("asks for a timeout on long-running commands", () => {
		expect(joined).toContain("timeout");
	});

	it("only commits/pushes when explicitly asked", () => {
		expect(joined).toContain("commit");
		expect(joined).toContain("explicitly");
	});

	it("discourages unnecessary cd chaining", () => {
		expect(joined).toContain("cd");
	});
});

describe("edit tool prompt guidance", () => {
	const def = createEditToolDefinition(process.cwd());
	const joined = guidelines(def).join("\n");

	it("requires reading before editing", () => {
		expect(joined).toContain("Read");
		expect(joined).toContain("before");
	});

	it("requires exact text matching and preserving indentation", () => {
		expect(joined).toContain("exactly");
		expect(joined).toContain("indentation");
	});

	it("says to keep edits unique but small", () => {
		expect(joined).toContain("unique");
	});

	it("says to merge nearby/overlapping edits", () => {
		expect(joined.toLowerCase()).toContain("merge");
		expect(joined.toLowerCase()).toContain("overlap");
	});

	it("says not to retry identical failing arguments blindly", () => {
		expect(joined).toContain("re-read");
		expect(joined).toContain("blindly");
	});

	it("says to re-read the changed region after editing", () => {
		expect(joined).toContain("After every edit");
	});
});

describe("write tool prompt guidance", () => {
	const def = createWriteToolDefinition(process.cwd());
	const joined = guidelines(def).join("\n");

	it("restricts write to new files or full rewrites", () => {
		expect(joined).toContain("new files");
		expect(joined).toContain("complete replacement");
	});

	it("prefers edit for existing files", () => {
		expect(joined).toContain("prefer edit");
	});

	it("puts ad-hoc scripts under /tmp", () => {
		expect(joined).toContain("/tmp");
	});

	it("re-reads after writing", () => {
		expect(joined).toContain("re-read");
	});
});
