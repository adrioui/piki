import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { typeboxToGbnf } from "../src/grammar/index.ts";
import {
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

	it("validates against schema - wrong type fails", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ name: Type.String(), count: Type.Number() }));
		const result = validatePartialAgainstSchema({ count: "not a number" }, schema);
		expect(result.valid).toBe(false);
		expect(result.issue).toContain("expected type number");
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

	it("marks Type.Optional fields as optional from parent required metadata", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ name: Type.String(), note: Type.Optional(Type.String()) }));
		const note = schema.children?.find((child) => child.name === "note");
		expect(note?.required).toBe(false);
	});

	it("validates Type.Integer fields as numbers", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ count: Type.Integer() }));
		const result = validatePartialAgainstSchema({ count: "1" }, schema);
		expect(result.valid).toBe(false);
		expect(result.issue).toContain("expected type number");
	});

	it("validates Type.Tuple fields positionally", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ pair: Type.Tuple([Type.String(), Type.Number()]) }));
		expect(validatePartialAgainstSchema({ pair: ["name", 1] }, schema).valid).toBe(true);

		const wrongType = validatePartialAgainstSchema({ pair: ["name", "1"] }, schema);
		expect(wrongType.valid).toBe(false);
		expect(wrongType.fieldPath).toBe("pair[1]");

		const tooLong = validatePartialAgainstSchema({ pair: ["name", 1, true] }, schema);
		expect(tooLong.valid).toBe(false);
		expect(tooLong.issue).toContain("expected tuple length 2");
	});

	it("includes field path for nested validation errors", () => {
		const schema = typeboxToStreamingSchema(Type.Object({ config: Type.Object({ count: Type.Number() }) }));
		const result = validatePartialAgainstSchema({ config: { count: "1" } }, schema);
		expect(result.valid).toBe(false);
		expect(result.fieldPath).toBe("config.count");
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
