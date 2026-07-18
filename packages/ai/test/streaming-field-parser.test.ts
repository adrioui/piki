import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createStructuredOutputInjector, typeboxToGbnf } from "../src/grammar/index.ts";
import {
	allowUnknownFieldsForStreaming,
	StreamingFieldParser,
	typeboxToStreamingSchema,
	validatePartialAgainstSchema,
} from "../src/streaming/index.ts";

describe("StreamingFieldParser", () => {
	it("parses complete JSON in one chunk", () => {
		const parser = new StreamingFieldParser();
		parser.push('{"name":"test","value":42}');
		expect(parser.partial).toEqual({ name: "test", value: 42 });
		expect(parser.valid).toBe(true);
	});

	it("parses JSON incrementally across chunks", () => {
		const parser = new StreamingFieldParser();
		parser.push('{"name":"');
		expect(parser.partial).toEqual({ name: "" });
		parser.push('test","val');
		expect(parser.partial).toEqual({ name: "test" });
		parser.push('ue":42}');
		expect(parser.partial).toEqual({ name: "test", value: 42 });
		expect(parser.valid).toBe(true);
	});

	it("handles nested objects", () => {
		const parser = new StreamingFieldParser();
		parser.push('{"outer":{"inner":"hello"}}');
		expect(parser.partial).toEqual({ outer: { inner: "hello" } });
	});

	it("handles arrays", () => {
		const parser = new StreamingFieldParser();
		parser.push('{"items":[1,2,3]}');
		expect(parser.partial).toEqual({ items: [1, 2, 3] });
	});

	it("decodes JSON string escapes while streaming", () => {
		const parser = new StreamingFieldParser();
		parser.push('{"msg":"hello\\tworld\\n","letter":"\\u0041"}');
		expect(parser.partial).toEqual({ msg: "hello\tworld\n", letter: "A" });
	});

	it("snapshot and restore", () => {
		const parser = new StreamingFieldParser();
		parser.push('{"name":"test"');
		const snap = parser.snapshot();
		parser.push(',"extra":"data"');
		expect(parser.partial).toEqual({ name: "test", extra: "data" });
		parser.restore(snap);
		expect(parser.partial).toEqual({ name: "test" });
	});

	it("validates against schema - uncoercible wrong type fails", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ name: Type.String(), count: Type.Number() }));
		const result = validatePartialAgainstSchema({ count: "not a number" }, schema);
		expect(result.valid).toBe(false);
		expect(result.issue).toContain("expected type number");
	});

	it("accepts primitive strings that final TypeBox validation can coerce", () => {
		const schema = typeboxToStreamingSchema(
			Type.Object({ offset: Type.Number(), limit: Type.Integer(), recursive: Type.Boolean() }),
		);
		expect(validatePartialAgainstSchema({ offset: "10", limit: "25", recursive: "false" }, schema).valid).toBe(true);
	});

	it("validates against schema - missing required passes (stream incomplete)", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ name: Type.String(), count: Type.Number() }));
		const result = validatePartialAgainstSchema({ name: "test" }, schema);
		expect(result.valid).toBe(true);
	});

	it("validates against schema - enum violation fails", () => {
		const schema = typeboxToStreamingSchema(
			Type.Object({ status: Type.Union([Type.Literal("active"), Type.Literal("inactive")]) }),
		);
		const result = validatePartialAgainstSchema({ status: "unknown" }, schema);
		expect(result.valid).toBe(false);
		expect(result.issue).toContain("must be one of");
	});

	it("accepts streaming enum prefixes until the final value is complete", () => {
		const schema = typeboxToStreamingSchema(
			Type.Object({ role: Type.Union([Type.Literal("scout"), Type.Literal("architect")]) }),
		);
		expect(validatePartialAgainstSchema({ role: "" }, schema).valid).toBe(true);
		expect(validatePartialAgainstSchema({ role: "sco" }, schema).valid).toBe(true);
		expect(validatePartialAgainstSchema({ role: "scout" }, schema).valid).toBe(true);
		expect(validatePartialAgainstSchema({ role: "engineer" }, schema).valid).toBe(false);
	});

	it("marks Type.Optional fields as optional from parent required metadata", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ name: Type.String(), note: Type.Optional(Type.String()) }));
		const note = schema.children?.find((child) => child.name === "note");
		expect(note?.required).toBe(false);
	});

	it("validates Type.Integer fields as numbers or numeric strings", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ count: Type.Integer() }));
		expect(validatePartialAgainstSchema({ count: 1 }, schema).valid).toBe(true);
		expect(validatePartialAgainstSchema({ count: "1" }, schema).valid).toBe(true);
	});

	it("validates Type.Tuple fields positionally", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ pair: Type.Tuple([Type.String(), Type.Number()]) }));
		expect(validatePartialAgainstSchema({ pair: ["name", 1] }, schema).valid).toBe(true);

		const wrongType = validatePartialAgainstSchema({ pair: ["name", "one"] }, schema);
		expect(wrongType.valid).toBe(false);
		expect(wrongType.fieldPath).toBe("pair[1]");

		const tooLong = validatePartialAgainstSchema({ pair: ["name", 1, true] }, schema);
		expect(tooLong.valid).toBe(false);
		expect(tooLong.issue).toContain("expected tuple length 2");
	});

	it("includes field path for nested validation errors", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ config: Type.Object({ count: Type.Number() }) }));
		const result = validatePartialAgainstSchema({ config: { count: "one" } }, schema);
		expect(result.valid).toBe(false);
		expect(result.fieldPath).toBe("config.count");
	});

	it("can defer unknown-field failures while still validating known field types", () => {
		const strictSchema = typeboxToStreamingSchema(Type.Object({ path: Type.String() }));
		const strictResult = validatePartialAgainstSchema({ path: "file.ts", unexpected: "value" }, strictSchema);
		expect(strictResult.valid).toBe(false);
		expect(strictResult.issue).toContain("Unknown field");

		const relaxedSchema = allowUnknownFieldsForStreaming(strictSchema);
		expect(validatePartialAgainstSchema({ path: "file.ts", unexpected: "value" }, relaxedSchema).valid).toBe(true);

		const wrongKnownType = validatePartialAgainstSchema({ path: 123, unexpected: "value" }, relaxedSchema);
		expect(wrongKnownType.valid).toBe(false);
		expect(wrongKnownType.fieldPath).toBe("path");
	});
});

describe("StreamingFieldParser partial-number no false abort", () => {
	it("keeps a partially streamed number valid across chunks", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ x: Type.Number() }));
		const parser = new StreamingFieldParser(schema);
		for (const chunk of ["{", '"x":1', ".5", "e3"]) {
			parser.push(chunk);
			expect(parser.valid).toBe(true);
		}
		parser.push("}");
		expect(parser.valid).toBe(true);
		expect((parser.partial as { x: number }).x).toBe(1.5e3);
	});

	it("keeps a partially streamed boolean valid across chunks", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ flag: Type.Boolean() }));
		const parser = new StreamingFieldParser(schema);
		for (const chunk of ["{", '"flag":tru', "e"]) {
			parser.push(chunk);
			expect(parser.valid).toBe(true);
		}
		parser.push("}");
		expect(parser.valid).toBe(true);
		expect((parser.partial as { flag: boolean }).flag).toBe(true);
	});

	it("keeps a partially streamed number inside an array valid across chunks", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ values: Type.Array(Type.Number()) }));
		const parser = new StreamingFieldParser(schema);
		for (const chunk of ["{", '"values":[1', ".5", "e3]"]) {
			parser.push(chunk);
			expect(parser.valid).toBe(true);
		}
		parser.push("}");
		expect(parser.valid).toBe(true);
		expect((parser.partial as { values: number[] }).values).toEqual([1.5e3]);
	});

	it("still aborts on a genuinely complete wrong-type value", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ x: Type.Number() }));
		const parser = new StreamingFieldParser(schema);
		parser.push('{"x":"hello"}');
		expect(parser.valid).toBe(false);
		expect(parser.validationIssue).toContain("expected type number");
	});
});

describe("typeboxToGbnf", () => {
	it("generates GBNF for simple object", () => {
		const gbnf = typeboxToGbnf(Type.Object({ name: Type.String() }));
		expect(gbnf).toContain("root ::=");
		expect(gbnf).toContain("string ::=");
		expect(gbnf).toContain("ws ::=");
	});

	it("generates alternatives for Type.Union literals", () => {
		const gbnf = typeboxToGbnf(
			Type.Object({ status: Type.Union([Type.Literal("active"), Type.Literal("inactive")]) }),
		);
		expect(gbnf).toContain('"\\"active\\"" | "\\"inactive\\""');
		expect(gbnf).not.toContain('ws "" ws');
	});

	it("makes optional object properties omittable", () => {
		const gbnf = typeboxToGbnf(Type.Object({ name: Type.String(), note: Type.Optional(Type.String()) }));
		expect(gbnf).toContain('root ::= "{" ws "\\"name\\"" ws ":" ws string root_optional_after_required ws "}"');
		expect(gbnf).toContain('root_optional_after_required ::= ("" | ws "," ws "\\"note\\"" ws ":" ws string)');
		expect(gbnf).toContain('"\\"note\\"" ws ":" ws string');
	});

	it("keeps all-optional object properties optional", () => {
		const gbnf = typeboxToGbnf(
			Type.Object({ first: Type.Optional(Type.String()), second: Type.Optional(Type.Number()) }),
		);
		expect(gbnf).toContain('root ::= "{" ws root_optional_start ws "}"');
		expect(gbnf).toContain('root_optional_start ::= ("" | "\\"first\\"" ws ":" ws string');
		expect(gbnf).toContain('"\\"second\\"" ws ":" ws number');
	});

	it("does not inject primitive rules from matching property names", () => {
		const gbnf = typeboxToGbnf(Type.Object({ value: Type.String() }));
		expect(gbnf).toContain('"\\"value\\"" ws ":" ws string');
		expect(gbnf).not.toContain("\nvalue ::=");
	});

	it("compiles Type.Any and Type.Unknown as JSON values", () => {
		const gbnf = typeboxToGbnf(Type.Object({ any: Type.Any(), unknown: Type.Unknown() }));
		expect(gbnf).toContain('"\\"any\\"" ws ":" ws value');
		expect(gbnf).toContain('"\\"unknown\\"" ws ":" ws value');
		expect(gbnf).toContain("value ::= string | number");
	});

	it("compiles Type.Intersect object schemas", () => {
		const gbnf = typeboxToGbnf(
			Type.Intersect([Type.Object({ first: Type.String() }), Type.Object({ second: Type.Number() })]),
		);
		expect(gbnf).toContain('"\\"first\\"" ws ":" ws string');
		expect(gbnf).toContain('"\\"second\\"" ws ":" ws number');
	});

	it("compiles Type.Record value schemas", () => {
		const gbnf = typeboxToGbnf(Type.Record(Type.String(), Type.Number()));
		expect(gbnf).toContain('root ::= "{" ws (string ws ":" ws number');
		expect(gbnf).toContain('(ws "," ws string ws ":" ws number)*');
	});

	it("wraps boolean alternatives when embedded", () => {
		const gbnf = typeboxToGbnf(Type.Object({ enabled: Type.Boolean() }));
		expect(gbnf).toContain('("true" | "false")');
	});

	it("falls back to JSON value for unknown primitive schema types", () => {
		const gbnf = typeboxToGbnf({ type: "constructor" } as never);
		expect(gbnf).toContain("root ::= value");
		expect(gbnf).toContain("value ::= string | number");
	});
});

describe("createStructuredOutputInjector", () => {
	it("does not combine response_format with native tool declarations", async () => {
		const injector = createStructuredOutputInjector([Type.Object({ value: Type.String() })]);
		const payload = {
			tools: [{ type: "function", function: { name: "echo" } }],
		};
		const result = await injector(payload, {
			id: "mock",
			name: "mock",
			api: "openai-completions",
			provider: "mock",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		expect(result).toBe(payload);
		expect(payload).not.toHaveProperty("response_format");
	});
});
