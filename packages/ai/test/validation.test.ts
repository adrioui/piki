import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { coerceToolArgs, validateToolArguments } from "../src/utils/validation.ts";

function createToolCallWithPlainSchema(
	schema: Tool["parameters"],
	value: unknown,
): {
	tool: Tool;
	toolCall: ToolCall;
} {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: {
			type: "object",
			properties: {
				value: schema,
			},
			required: ["value"],
		} as Tool["parameters"],
	};

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool-1",
		name: "echo",
		arguments: { value },
	};

	return { tool, toolCall };
}

describe("validateToolArguments", () => {
	it("still validates when Function constructor is unavailable", () => {
		const originalFunction = globalThis.Function;
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" as unknown as number },
		};

		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
		} finally {
			globalThis.Function = originalFunction;
		}
	});

	it("coerces serialized plain JSON schemas with AJV-compatible primitive rules", () => {
		const passingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
			expected: unknown;
		}> = [
			{ schema: { type: "number" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "number" } as Tool["parameters"], input: true, expected: 1 },
			{ schema: { type: "number" } as Tool["parameters"], input: null, expected: 0 },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "true", expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "false", expected: false },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 1, expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 0, expected: false },
			{ schema: { type: "string" } as Tool["parameters"], input: null, expected: "" },
			{ schema: { type: "string" } as Tool["parameters"], input: true, expected: "true" },
			{ schema: { type: "null" } as Tool["parameters"], input: "", expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: 0, expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: false, expected: null },
			{
				schema: { type: ["number", "string"] } as Tool["parameters"],
				input: "1",
				expected: "1",
			},
			{
				schema: { type: ["boolean", "number"] } as Tool["parameters"],
				input: "1",
				expected: 1,
			},
		];

		for (const testCase of passingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		const failingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
		}> = [
			{ schema: { type: "boolean" } as Tool["parameters"], input: "1" },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "0" },
			{ schema: { type: "null" } as Tool["parameters"], input: "null" },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42.1" },
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});
});

describe("coerceToolArgs (toolfix.go parity)", () => {
	const id = (v: unknown) => v;

	it("coerces numeric string params per tool", () => {
		expect(coerceToolArgs("read", { offset: "10", limit: "50" })).toEqual({ offset: 10, limit: 50 });
		expect(coerceToolArgs("grep", { limit: "100" })).toEqual({ limit: 100 });
		expect(coerceToolArgs("tree", { maxDepth: "3" })).toEqual({ maxDepth: 3 });
		expect(coerceToolArgs("shell", { detach_after: "20" })).toEqual({ detach_after: 20 });
		expect(coerceToolArgs("bash", { detach_after: "20" })).toEqual({ detach_after: 20 });
	});

	it("coerces boolean string params per tool", () => {
		expect(coerceToolArgs("edit", { replaceAll: "true" })).toEqual({ replaceAll: true });
		expect(coerceToolArgs("edit", { replaceAll: "false" })).toEqual({ replaceAll: false });
		expect(coerceToolArgs("tree", { recursive: "true", gitignore: "false" })).toEqual({
			recursive: true,
			gitignore: false,
		});
		expect(coerceToolArgs("spawn_worker", { yield: "true" })).toEqual({ yield: true });
		expect(coerceToolArgs("spawnWorker", { yield: "false" })).toEqual({ yield: false });
	});

	it("normalizes update_task status synonyms", () => {
		expect(coerceToolArgs("update_task", { status: "working" })).toEqual({ status: "pending" });
		expect(coerceToolArgs("update_task", { status: "done" })).toEqual({ status: "completed" });
		expect(coerceToolArgs("update_task", { status: "canceled" })).toEqual({ status: "cancelled" });
		expect(coerceToolArgs("updateTask", { status: "in_progress" })).toEqual({ status: "pending" });
		expect(coerceToolArgs("update_task", { status: "pending" })).toEqual({ status: "pending" });
	});

	it("repairs compact.files object->array and injects reflection", () => {
		expect(coerceToolArgs("compact", { files: { "0": "a", "1": "b" } })).toEqual({
			files: ["a", "b"],
			reflection: "",
		});
		expect(coerceToolArgs("compact", { files: ["a", "b"] })).toEqual({ files: ["a", "b"], reflection: "" });
		expect(coerceToolArgs("compact", {})).toEqual({ reflection: "" });
	});

	it("does not mutate the input or touch unaffected fields", () => {
		const input = { offset: "5", path: "/x" } as Record<string, unknown>;
		const out = coerceToolArgs("read", input);
		expect(input).toEqual({ offset: "5", path: "/x" });
		expect(out).toEqual({ offset: 5, path: "/x" });
		id(out);
	});

	it("passes through non-object params", () => {
		expect(coerceToolArgs("read", "garbage" as unknown)).toBe("garbage");
		expect(coerceToolArgs("read", null)).toBe(null);
	});
});
