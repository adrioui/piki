import { describe, expect, it } from "vitest";
import {
	describeShape,
	estimateAgentToolResult,
	estimateCompletedTurn,
	estimateResultTokensTagged,
	estimateText,
	renderFeedbackText,
	TRUNCATION_TOKEN_LIMIT,
} from "../../src/utils/token-estimate.ts";

describe("estimateText", () => {
	it("chars/4 rounded up", () => {
		expect(estimateText("")).toBe(0);
		expect(estimateText("a")).toBe(1);
		expect(estimateText("abcd")).toBe(1);
		expect(estimateText("abcde")).toBe(2);
	});
});

describe("describeShape", () => {
	it("null → null", () => {
		expect(describeShape(null)).toBe("null");
	});

	it("objects list keys (cap 8)", () => {
		expect(describeShape({ a: 1 })).toBe("{a}");
		const big = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
		expect(describeShape(big)).toBe("{k0,k1,k2,k3,k4,k5,k6,k7,…}");
	});

	it("arrays show length + head shape", () => {
		expect(describeShape([1, 2, 3])).toBe("[len=3, number]");
	});

	it("empty array shows ∅ head", () => {
		expect(describeShape([])).toBe("[len=0, ∅]");
	});

	it("depth-capped at 3", () => {
		// depth=0 outer object returns keys; the depth>=3 check only fires when depth reaches 3.
		expect(describeShape({ a: { b: { c: { d: 1 } } } })).toBe("{a}");
		// at depth=3, the object itself is capsulated.
		expect(describeShape({ d: 1 }, 3)).toBe("{…}");
	});

	it("nested array depth-caps", () => {
		// [[[[1]]]] — depth 0 recurses to 1, 1→2, 2→3 (capped at >= 3 → […]).
		const deep = [[[[1]]]];
		expect(describeShape(deep)).toBe("[len=1, [len=1, [len=1, […]]]]");
		// [[[[[1]]]]] — one level deeper; same cap point reached one level sooner.
		const tooDeep = [[[[[1]]]]];
		expect(describeShape(tooDeep)).toBe("[len=1, [len=1, [len=1, […]]]]");
	});

	it("nested object depth-caps", () => {
		const deep = { a: { b: { c: {} } } };
		expect(describeShape(deep)).toBe("{a}");
	});
});

describe("renderFeedbackText", () => {
	it("passes strings through", () => {
		expect(renderFeedbackText("hello")).toBe("hello");
	});

	it("stringifies objects", () => {
		expect(renderFeedbackText({ ok: true })).toBe('{"ok":true}');
	});

	it("handles null/undefined", () => {
		expect(renderFeedbackText(null)).toBe("null");
		expect(renderFeedbackText(undefined)).toBe("");
	});
});

describe("estimateResultTokensTagged", () => {
	it("Success undefined → 10", () => {
		expect(estimateResultTokensTagged({ _tag: "Success" })).toBe(10);
	});

	it("Error → message length/4 + 30", () => {
		const msg = "x".repeat(40);
		expect(estimateResultTokensTagged({ _tag: "Error", error: { message: msg } })).toBe(Math.ceil(40 / 4) + 30);
	});

	it("Denied string → denial length/4 + 30", () => {
		expect(estimateResultTokensTagged({ _tag: "Denied", denial: "nope" })).toBe(Math.ceil(4 / 4) + 30);
	});

	it("Denied object → JSON.stringify length/4 + 30", () => {
		const obj = { reason: "denied" };
		expect(estimateResultTokensTagged({ _tag: "Denied", denial: obj })).toBe(
			Math.ceil(JSON.stringify(obj).length / 4) + 30,
		);
	});

	it("Interrupted → 10", () => {
		expect(estimateResultTokensTagged({ _tag: "Interrupted" })).toBe(10);
	});

	it("InputRejected → partialInput JSON length/4 + 80", () => {
		const p = { foo: "bar" };
		expect(estimateResultTokensTagged({ _tag: "InputRejected", partialInput: p })).toBe(
			Math.ceil(JSON.stringify(p).length / 4) + 80,
		);
	});

	it("Success collapses to shape when > TRUNCATION_TOKEN_LIMIT", () => {
		const big = { data: "x".repeat(TRUNCATION_TOKEN_LIMIT * 4 + 100) };
		const full = Math.ceil(JSON.stringify(big).length / 4);
		expect(full).toBeGreaterThan(TRUNCATION_TOKEN_LIMIT);
		expect(estimateResultTokensTagged({ _tag: "Success", output: big })).toBe(
			Math.ceil(describeShape(big).length / 4) + 50,
		);
	});

	it("Success JSON.stringify throws → 50", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(estimateResultTokensTagged({ _tag: "Success", output: cyclic })).toBe(50);
	});
});

describe("estimateAgentToolResult (pi-shaped)", () => {
	it("text-only content + null details", () => {
		// text "abcd" = 4 chars, safeStringify(null) = "null" = 4 chars → total 8 → ceil(8/4) = 2
		const result = estimateAgentToolResult({
			content: [{ type: "text", text: "abcd" }],
			details: null,
		});
		expect(result).toBe(2);
	});

	it("image block adds ESTIMATED_IMAGE_CHARS", () => {
		// image block = 4800 chars, safeStringify(null) = "null" = 4 → total 4804 → ceil(4804/4) = 1201
		const result = estimateAgentToolResult({
			content: [{ type: "image" } as { type: string; text?: string }],
			details: null,
		});
		expect(result).toBe(1201);
	});

	it("mixed text + image + details sum", () => {
		// text "hello" = 5, image = 4800, details {a:1} = '{"a":1}' = 6 chars → total 4811 → ceil(4811/4) = 1203
		const result = estimateAgentToolResult({
			content: [{ type: "text", text: "hello" }, { type: "image" } as { type: string; text?: string }],
			details: { a: 1 },
		});
		expect(result).toBe(1203);
	});

	it("cyclic details → safeStringify returns '' → only content chars counted", () => {
		// text "abc" = 3 chars, details throws → "" = 0 chars → total 3 → ceil(3/4) = 1
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const result = estimateAgentToolResult({
			content: [{ type: "text", text: "abc" }],
			details: cyclic,
		});
		expect(result).toBe(1);
	});

	it("mixed non-text/image blocks all use ESTIMATED_IMAGE_CHARS", () => {
		// two non-text blocks = 4800 each = 9600, no details → safeStringify(undefined) = "" = 0
		// Actually the arg has no details field, so safeStringify(undefined) returns "" = 0
		// Total = 9600 → ceil(9600/4) = 2400
		const result = estimateAgentToolResult({
			content: [{ type: "tool_result" }, { type: "thinking", thinking: "foo" }] as any,
			details: undefined,
		});
		expect(result).toBe(2400);
	});
});

describe("estimateCompletedTurn", () => {
	it("sums assistant + toolCalls + per-result + feedback", () => {
		const turn = {
			assistant: {
				reasoning: "abc",
				text: "def",
				toolCalls: [{ name: "ls", input: {} }],
			},
			toolResults: [{ result: { _tag: "Success" as const } }],
			feedback: "ok",
		};
		// estimateText("abc") = ceil(3/4) = 1
		// estimateText("def") = ceil(3/4) = 1
		// tc: estimateText("ls") = ceil(2/4) = 1, estimateText("{}") = ceil(2/4) = 1, +20 = 22
		// toolResults: {_tag:"Success"} → 10
		// feedback "ok" → renderFeedbackText("ok") = "ok" → estimateText("ok") = ceil(2/4) = 1
		// total = 1 + 1 + (1 + 1 + 20) + 10 + 1 = 35
		expect(estimateCompletedTurn(turn as any)).toBe(35);
	});

	it("handles missing fields", () => {
		const turn = {
			assistant: {},
			toolResults: [],
			feedback: undefined,
		};
		// 0 + 0 + 0 + 0 + estimateText(renderFeedbackText(undefined)) = estimateText("") = 0
		expect(estimateCompletedTurn(turn as any)).toBe(0);
	});
});
