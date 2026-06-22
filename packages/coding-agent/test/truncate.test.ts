import { describe, expect, test } from "vitest";
import { truncateTailForModel } from "../src/core/tools/truncate.ts";

describe("truncateTailForModel", () => {
	test("preserves small output unchanged with no banner", () => {
		const small = "line 1\nline 2\nline 3";
		const { text, truncation } = truncateTailForModel(small, { maxLines: 100, maxBytes: 100 * 1024 });
		expect(text).toBe(small);
		expect(truncation.truncated).toBe(false);
	});

	test("keeps the tail and prepends a deterministic banner for long output", () => {
		// 50 lines, each unique, final line carries the actionable result.
		const lines: string[] = [];
		for (let i = 1; i <= 50; i++) {
			lines.push(`line-${String(i).padStart(3, "0")}`);
		}
		lines.push("FATAL: build failed at the end");
		const content = lines.join("\n");

		const { text, truncation } = truncateTailForModel(content, { maxLines: 10, maxBytes: 100 * 1024 });

		expect(truncation.truncated).toBe(true);
		// Banner states how many lines were dropped above.
		expect(text).toContain("--- Truncated 41 lines above this point ---");
		// The actionable tail (final error) is preserved.
		expect(text).toContain("FATAL: build failed at the end");
		expect(text).toContain("line-050");
		// Dropped head content is gone.
		expect(text).not.toContain("line-001");
	});

	test("banner count reflects total minus output lines", () => {
		const lines: string[] = [];
		for (let i = 1; i <= 30; i++) lines.push(`l${i}`);
		const content = lines.join("\n");

		const { text, truncation } = truncateTailForModel(content, { maxLines: 5, maxBytes: 100 * 1024 });
		expect(truncation.totalLines).toBe(30);
		expect(truncation.outputLines).toBe(5);
		expect(text).toContain("--- Truncated 25 lines above this point ---");
	});

	test("empty content is preserved unchanged", () => {
		const { text, truncation } = truncateTailForModel("", { maxLines: 10, maxBytes: 1024 });
		expect(text).toBe("");
		expect(truncation.truncated).toBe(false);
	});
});
