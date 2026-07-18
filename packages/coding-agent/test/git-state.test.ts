/**
 * Tests for src/core/git-state.ts — porcelain v2 parser and collector.
 */

import { describe, expect, it } from "vitest";
import { parsePorcelainV2 } from "../src/core/git-state.ts";

describe("parsePorcelainV2", () => {
	it("parses a modified (1 XY) entry", () => {
		const entries = parsePorcelainV2("1 M. N... 100644 100644 100644 100644 100644 a.ts\n");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ x: "M", y: ".", path: "a.ts" });
	});

	it("captures oldPath for a rename (2 XY R100)", () => {
		const entries = parsePorcelainV2("2 R. R100 100644 100644 100644 100644 100644 b.ts\ta.ts\n");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ x: "R", y: ".", path: "b.ts", oldPath: "a.ts" });
	});

	it("parses an unmerged (u XY) entry", () => {
		const entries = parsePorcelainV2("u UU N... 100644 100644 100644 100644 100644 100644 100644 conflict.ts\n");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ x: "U", y: "U", path: "conflict.ts" });
	});

	it("parses an untracked (?) entry", () => {
		const entries = parsePorcelainV2("? new.ts\n");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ x: "?", y: "?", path: "new.ts" });
	});

	it("parses an ignored (!) entry", () => {
		const entries = parsePorcelainV2("! node_modules/foo\n");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ x: "!", y: "!", path: "node_modules/foo" });
	});

	it("skips malformed lines", () => {
		const entries = parsePorcelainV2("garbage line\n1\n? ok.ts\n");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.path).toBe("ok.ts");
	});

	it("handles empty input", () => {
		expect(parsePorcelainV2("")).toHaveLength(0);
		expect(parsePorcelainV2("\n\n")).toHaveLength(0);
	});

	it("parses multiple entries of mixed kinds", () => {
		const raw = [
			"1 M. N... 100644 100644 100644 100644 100644 modified.ts",
			"2 A. R100 100644 100644 100644 100644 100644 new.ts\told.ts",
			"? untracked.ts",
			"! ignored.log",
		].join("\n");
		const entries = parsePorcelainV2(raw);
		expect(entries).toHaveLength(4);
		expect(entries.map((e) => e.path)).toEqual(["modified.ts", "new.ts", "untracked.ts", "ignored.log"]);
		expect(entries[1]!.oldPath).toBe("old.ts");
	});
});
