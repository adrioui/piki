/**
 * Tests for the subagent registry.
 */

import { describe, expect, it } from "vitest";
import { getSubagentSpec, listSubagentSpecs } from "../src/core/subagent/registry.ts";

describe("subagent registry", () => {
	it("getSubagentSpec('finder') returns the finder spec", () => {
		const spec = getSubagentSpec("finder");
		expect(spec).toBeDefined();
		expect(spec!.name).toBe("finder");
		expect(spec!.systemPrompt).toContain("finder subagent");
		expect(spec!.allowedTools).toContain("grep");
		expect(spec!.allowedTools).toContain("find");
		expect(spec!.allowedTools).toContain("read");
		expect(spec!.allowedTools).toContain("ls");
		expect(spec!.allowedTools).toContain("bash");
	});

	it("getSubagentSpec('oracle') returns a read-only expert-advisor spec", () => {
		const spec = getSubagentSpec("oracle");
		expect(spec).toBeDefined();
		expect(spec!.name).toBe("oracle");
		expect(spec!.systemPrompt).toContain("expert senior engineering advisor");
		expect(spec!.systemPrompt).toContain("Never edit or write files");
		expect(spec!.systemPrompt).toContain("simplest option");
		expect(spec!.systemPrompt).toContain("actionable risks");
		expect(spec!.allowedTools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(spec!.allowedTools).not.toContain("edit");
		expect(spec!.allowedTools).not.toContain("write");
	});

	it("unknown name returns undefined", () => {
		expect(getSubagentSpec("nonexistent")).toBeUndefined();
	});

	it("listSubagentSpecs includes finder and oracle", () => {
		const specs = listSubagentSpecs();
		expect(specs).toContain("finder");
		expect(specs).toContain("oracle");
	});
});
