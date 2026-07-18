import { describe, expect, test } from "vitest";
import { formatToolResultForModel } from "../src/core/activity-formatter.ts";

describe("formatToolResultForModel", () => {
	test("prefixes shell results with the command", () => {
		const content = formatToolResultForModel(
			"shell",
			{ command: "npm test" },
			{ content: [{ type: "text", text: "ok" }], details: undefined },
			false,
		);

		expect(content).toEqual([{ type: "text", text: "[bash] $ npm test\nok" }]);
	});

	test("prefixes edit and write results with paths", () => {
		expect(
			formatToolResultForModel(
				"edit",
				{ file_path: "/repo/src/a.ts" },
				{ content: [{ type: "text", text: "updated" }], details: undefined },
				false,
			),
		).toEqual([{ type: "text", text: "[edit] /repo/src/a.ts\nupdated" }]);

		expect(
			formatToolResultForModel(
				"write",
				{ path: "/repo/src/b.ts" },
				{ content: [{ type: "text", text: "created" }], details: undefined },
				false,
			),
		).toEqual([{ type: "text", text: "[write] /repo/src/b.ts\ncreated" }]);
	});

	test("leaves reads and errors unchanged", () => {
		const result = { content: [{ type: "text" as const, text: "file contents" }], details: undefined };

		expect(formatToolResultForModel("read", { file_path: "/repo/a.ts" }, result, false)).toBeUndefined();
		expect(formatToolResultForModel("shell", { command: "bad" }, result, true)).toBeUndefined();
	});

	test("does not double-prefix already formatted activity results", () => {
		expect(
			formatToolResultForModel(
				"shell",
				{ command: "npm test" },
				{ content: [{ type: "text", text: "[bash] $ npm test\nok" }], details: undefined },
				false,
			),
		).toBeUndefined();
	});
});
