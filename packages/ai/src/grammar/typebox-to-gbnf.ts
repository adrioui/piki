/**
 * GBNF (Grammar-Based Sampling Format) compiler for Typebox schemas.
 *
 * Converts Typebox schemas into GBNF grammar rules that can be injected into
 * llama.cpp/vLLM requests for grammar-constrained generation.
 *
 * Typebox → GBNF mapping:
 * - Type.Object({...}) → root ::= "{" ws "\"key\"" ws ":" ws value ws "}"
 * - Type.Optional(...) → (...)?
 * - Type.Union([...]) → alternatives joined with |
 * - Type.Array(...) → array ::= "[" ws (item (ws "," ws item)*)? ws "]"
 * - Type.Number() → [0-9]+ ("." [0-9]+)?
 * - Type.Boolean() → ("true" | "false")
 * - Enum (Type.Literal) → quoted string literals joined with |
 * - Nested objects → generate named rule, reference it
 */

import type { TSchema } from "typebox";

interface GbnfContext {
	rules: Map<string, string>;
	seenRefs: Set<string>;
	usedPrimitives: Set<string>;
	counter: number;
}

export function typeboxToGbnf(schema: TSchema, rootName = "root"): string {
	const ctx: GbnfContext = {
		rules: new Map(),
		seenRefs: new Set(),
		usedPrimitives: new Set(),
		counter: 0,
	};

	const rootRule = compileSchema(schema, rootName, ctx);
	ctx.rules.set(rootName, rootRule);

	const lines: string[] = [];
	for (const [name, rule] of ctx.rules) {
		lines.push(`${name} ::= ${rule}`);
	}

	const primitiveRules: Record<string, string> = {
		string: '"\\"" ([^"\\\\] | "\\\\" .)* "\\""',
		number: '[0-9]+ ("." [0-9]+)? (("e" | "E") ("+" | "-")? [0-9]+)?',
		value: 'string | number | ("true" | "false") | "null"',
		ws: "[ \\t\\n]*",
	};
	for (const [name, rule] of Object.entries(primitiveRules)) {
		if (ctx.usedPrimitives.has(name) && !ctx.rules.has(name)) {
			lines.push(`${name} ::= ${rule}`);
		}
	}

	return lines.join("\n");
}

function compileSchema(schema: TSchema, name: string, ctx: GbnfContext): string {
	const type = (schema as { type?: string | string[] }).type;

	// 11.2: Detect recursive/self-referencing schemas
	const ref = (schema as { $ref?: string }).$ref ?? (schema as { $id?: string }).$id;
	if (ref && ctx.rules.has(ref)) {
		// Reference to an already-compiled rule — enables recursion
		ctx.seenRefs.add(ref);
		return ref;
	}

	const allOf = (schema as { allOf?: TSchema[] }).allOf;
	if (allOf && allOf.length > 0) {
		return compileObject(mergeObjectSchemas(allOf), name, ctx);
	}

	const patternProperties = (schema as { patternProperties?: Record<string, TSchema> }).patternProperties;
	if (patternProperties && Object.keys(patternProperties).length > 0) {
		return compileRecord(schema, name, ctx);
	}

	if (type === "object" || (schema as { properties?: unknown }).properties) {
		return compileObject(schema, name, ctx);
	}

	if (type === "array" || (schema as { items?: unknown }).items) {
		return compileArray(schema, name, ctx);
	}

	if (Array.isArray(type)) {
		const alternatives = type.map((t) => compilePrimitive(t as string, schema, ctx)).filter(Boolean);
		return alternatives.length > 0 ? alternatives.join(" | ") : '""';
	}

	const anyOf = (schema as { anyOf?: TSchema[] }).anyOf;
	if (anyOf && anyOf.length > 0) {
		const alternatives = anyOf.map((entry) => compileSchema(entry, name, ctx)).filter(Boolean);
		return alternatives.length > 0 ? `(${alternatives.join(" | ")})` : '""';
	}

	const constValue = (schema as { const?: unknown }).const;
	if (constValue !== undefined) {
		return jsonStringLiteral(String(constValue));
	}

	const enumValues = (schema as { enum?: unknown[] }).enum;
	if (enumValues) {
		return enumValues.map((v) => jsonStringLiteral(String(v))).join(" | ");
	}

	return compilePrimitive(type, schema, ctx);
}

function compileObject(schema: TSchema, name: string, ctx: GbnfContext): string {
	const properties = (schema as { properties?: Record<string, TSchema> }).properties ?? {};
	const required = (schema as { required?: string[] }).required ?? [];
	const keys = Object.keys(properties);
	markPrimitive(ctx, "ws");
	if (keys.length === 0) return '"{" ws "}"';

	const pairs = keys.map((key) => {
		const childSchema = properties[key]!;
		const childType = (childSchema as { type?: string }).type;
		let valueRule: string;
		if (childType === "object" || childType === "array") {
			const childName = `${name}_${key}`;
			if (!ctx.rules.has(childName) && !ctx.seenRefs.has(childName)) {
				ctx.seenRefs.add(childName);
				const childRule = compileSchema(childSchema, childName, ctx);
				ctx.rules.set(childName, childRule);
			}
			valueRule = childName;
		} else {
			valueRule = compileSchema(childSchema, `${name}_${key}`, ctx);
		}
		return { key, required: required.includes(key), rule: `"\\"${escapeString(key)}\\"" ws ":" ws ${valueRule}` };
	});

	const requiredPairs = pairs.filter((pair) => pair.required);
	const optionalPairs = pairs.filter((pair) => !pair.required);
	const requiredBody = requiredPairs.map((pair) => pair.rule).join(' ws "," ws ');
	const optionalTail =
		optionalPairs.length > 0 ? compileOptionalTail(optionalPairs, name, ctx, requiredPairs.length > 0) : "";
	const body = [requiredBody, optionalTail].filter(Boolean).join(" ");
	return body ? `"{" ws ${body} ws "}"` : '"{" ws "}"';
}

function compileArray(schema: TSchema, name: string, ctx: GbnfContext): string {
	const items = (schema as { items?: TSchema | TSchema[] }).items;
	markPrimitive(ctx, "ws");
	if (!items) return '"[" ws "]"';

	// Tuple schema: items is an array of schemas (positional)
	if (Array.isArray(items)) {
		if (items.length === 0) return '"[" ws "]"';
		const elementRules = items.map((itemSchema, i) => {
			const itemType = (itemSchema as { type?: string }).type;
			if (itemType === "object" || itemType === "array") {
				const elemName = `${name}_elem${i}`;
				if (!ctx.rules.has(elemName) && !ctx.seenRefs.has(elemName)) {
					ctx.seenRefs.add(elemName);
					const elemRule = compileSchema(itemSchema, elemName, ctx);
					ctx.rules.set(elemName, elemRule);
				}
				return elemName;
			}
			return compileSchema(itemSchema, `${name}_elem${i}`, ctx);
		});
		const body = elementRules.join(' ws "," ws ');
		return `"[" ws ${body} ws "]"`;
	}

	const itemType = (items as { type?: string }).type;
	if (itemType === "object" || itemType === "array") {
		const itemName = `${name}_item`;
		if (!ctx.rules.has(itemName) && !ctx.seenRefs.has(itemName)) {
			ctx.seenRefs.add(itemName);
			const itemRule = compileSchema(items, itemName, ctx);
			ctx.rules.set(itemName, itemRule);
		}
		return `"[" ws (${itemName} (ws "," ws ${itemName})*)? ws "]"`;
	}

	const primitive = compileSchema(items, `${name}_item`, ctx);
	return `"[" ws (${primitive} (ws "," ws ${primitive})*)? ws "]"`;
}

function compilePrimitive(type: string | string[] | undefined, _schema: TSchema, ctx: GbnfContext): string {
	switch (type) {
		case "string": {
			markPrimitive(ctx, "string");
			const pattern = (_schema as { pattern?: string }).pattern;
			if (pattern) {
				// GBNF doesn't support full regex; fall back to string rule
				// Pattern constraints are validated at the schema-adapter level instead
			}
			return "string";
		}
		case "number":
		case "integer": {
			markPrimitive(ctx, "number");
			// minimum/maximum constraints validated at schema-adapter level
			// GBNF number rule already constrains to numeric format
			return "number";
		}
		case "boolean":
			return '("true" | "false")';
		case "null":
			return '"null"';
		case undefined:
		case "any":
		case "unknown":
			markPrimitive(ctx, "value");
			return "value";
		default:
			markPrimitive(ctx, "value");
			return "value";
	}
}

function compileRecord(schema: TSchema, name: string, ctx: GbnfContext): string {
	const patternProperties = (schema as { patternProperties?: Record<string, TSchema> }).patternProperties ?? {};
	const valueSchema = Object.values(patternProperties)[0];
	if (!valueSchema) return '"{" ws "}"';
	markPrimitive(ctx, "ws");
	markPrimitive(ctx, "string");
	const valueRule = compileSchema(valueSchema, `${name}_value`, ctx);
	return `"{" ws (string ws ":" ws ${valueRule} (ws "," ws string ws ":" ws ${valueRule})*)? ws "}"`;
}

function compileOptionalTail(
	pairs: Array<{ key: string; required: boolean; rule: string }>,
	name: string,
	ctx: GbnfContext,
	startsWithComma: boolean,
): string {
	const startName = `${name}_optional_${startsWithComma ? "after_required" : "start"}`;
	const alternatives = ['""'];
	for (let i = 0; i < pairs.length; i++) {
		const suffix = compileOptionalCommaTail(pairs, i + 1, name, ctx);
		const separator = startsWithComma ? 'ws "," ws ' : "";
		alternatives.push(`${separator}${pairs[i]!.rule}${suffix ? ` ${suffix}` : ""}`);
	}
	ctx.rules.set(startName, `(${alternatives.join(" | ")})`);
	return startName;
}

function compileOptionalCommaTail(
	pairs: Array<{ key: string; required: boolean; rule: string }>,
	startIndex: number,
	name: string,
	ctx: GbnfContext,
): string {
	if (startIndex >= pairs.length) return "";
	const ruleName = `${name}_optional_tail_${startIndex}`;
	if (ctx.rules.has(ruleName)) return ruleName;
	const alternatives = ['""'];
	for (let i = startIndex; i < pairs.length; i++) {
		const suffix = compileOptionalCommaTail(pairs, i + 1, name, ctx);
		alternatives.push(`ws "," ws ${pairs[i]!.rule}${suffix ? ` ${suffix}` : ""}`);
	}
	ctx.rules.set(ruleName, `(${alternatives.join(" | ")})`);
	return ruleName;
}

function mergeObjectSchemas(schemas: readonly TSchema[]): TSchema {
	const properties: Record<string, TSchema> = {};
	const required = new Set<string>();
	for (const schema of schemas) {
		const subAllOf = (schema as { allOf?: TSchema[] }).allOf;
		const normalized = subAllOf && subAllOf.length > 0 ? mergeObjectSchemas(subAllOf) : schema;
		Object.assign(properties, (normalized as { properties?: Record<string, TSchema> }).properties ?? {});
		for (const key of (normalized as { required?: string[] }).required ?? []) {
			required.add(key);
		}
	}
	return { type: "object", properties, required: [...required] } as TSchema;
}

function markPrimitive(ctx: GbnfContext, name: string): void {
	ctx.usedPrimitives.add(name);
	if (name === "value") {
		ctx.usedPrimitives.add("string");
		ctx.usedPrimitives.add("number");
	}
}

function escapeString(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function jsonStringLiteral(s: string): string {
	return `"\\"${escapeString(s)}\\""`;
}
