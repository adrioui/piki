/**
 * Effect Schema-based streaming schema derivation.
 * Used by the NativeChatCompletions codec for incremental validation.
 */

import { Effect, ParseResult, Schema, SchemaAST } from "effect";
import type { ParsedValue } from "./parser/machine.ts";
import { parsedValueToJson } from "./values.ts";

function incomplete() {
	return { _tag: "Incomplete" as const };
}

function complete<T>(value: T) {
	return { _tag: "Complete" as const, value };
}

function schemaFromAST(ast: SchemaAST.AST) {
	return Schema.make(ast);
}

function isComplete(node: ParsedValue): boolean {
	return node.state === "complete";
}

function isObjectRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null;
}

function isCompletionState(input: unknown): input is "complete" | "incomplete" {
	return input === "complete" || input === "incomplete";
}

function isParsedValue(input: unknown): input is ParsedValue {
	if (!isObjectRecord(input) || typeof input._tag !== "string") return false;
	switch (input._tag) {
		case "string":
		case "number":
			return typeof input.value === "string" && isCompletionState(input.state);
		case "boolean":
			return typeof input.value === "boolean" && input.state === "complete";
		case "null":
			return input.state === "complete";
		case "object":
			return (
				isCompletionState(input.state) &&
				Array.isArray(input.entries) &&
				input.entries.every(
					(entry: unknown) =>
						Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && isParsedValue(entry[1]),
				)
			);
		case "array":
			return isCompletionState(input.state) && Array.isArray(input.items) && input.items.every(isParsedValue);
		default:
			return false;
	}
}

function declareStreamingSchema(
	decode: (
		node: ParsedValue,
		options: SchemaAST.ParseOptions,
		ast: SchemaAST.Declaration,
	) => Effect.Effect<StreamingCompletion<unknown>, ParseResult.ParseIssue>,
): Schema.Schema<StreamingCompletion<unknown>, unknown> {
	return Schema.declare<StreamingCompletion<unknown>, unknown, readonly []>([], {
		decode: () => (input: unknown, options: SchemaAST.ParseOptions, ast: SchemaAST.Declaration) => {
			if (!isParsedValue(input)) {
				return Effect.fail(new ParseResult.Type(ast, input, "Expected ParsedValue"));
			}
			return decode(input, options, ast);
		},
		encode: () => (input: unknown, _options: SchemaAST.ParseOptions, ast: SchemaAST.Declaration) =>
			Effect.fail(new ParseResult.Forbidden(ast, input, "Streaming schemas are decode-only")),
	});
}

export type StreamingCompletion<T> = { _tag: "Incomplete" } | { _tag: "Complete"; value: T };

function decodeComplete(
	schema: Schema.Schema<unknown>,
	node: ParsedValue,
): Effect.Effect<StreamingCompletion<unknown>, ParseResult.ParseIssue> {
	const result = ParseResult.decodeUnknownEither(schema)(parsedValueToJson(node));
	if (result._tag === "Left") {
		return Effect.fail(result.left);
	}
	return Effect.succeed(complete(result.right));
}

function duplicateKeyIssue(key: string, node: ParsedValue): ParseResult.Pointer {
	return new ParseResult.Pointer(
		key,
		node,
		new ParseResult.Type(SchemaAST.unknownKeyword, node, `Duplicate object key "${key}"`),
	);
}

function findDuplicateKeyIssue(node: Extract<ParsedValue, { _tag: "object" }>): ParseResult.Pointer | null {
	const seen = new Set<string>();
	for (const [key, value] of node.entries) {
		if (seen.has(key) && value.state === "complete") {
			return duplicateKeyIssue(key, node);
		}
		seen.add(key);
	}
	return null;
}

function decodeChild(
	child: StreamingSchemaNode,
	value: ParsedValue,
	path: string | number,
	actual: ParsedValue,
): ParseResult.Pointer | null {
	const result = ParseResult.decodeUnknownEither(child.streamingSchema as Schema.Schema<unknown>)(value);
	if (result._tag === "Right") return null;
	return new ParseResult.Pointer(path, actual, result.left);
}

export interface StreamingSchemaNode {
	completeSchema: Schema.Schema<unknown> | null;
	streamingSchema: Schema.Schema.All;
	childForObjectKey?(key: string): StreamingSchemaNode | null;
	childForArrayIndex?(index: number): StreamingSchemaNode | null;
}

class UnknownStreamingSchema implements StreamingSchemaNode {
	completeSchema = null;
	streamingSchema = declareStreamingSchema(() => Effect.succeed(incomplete()));
	childForObjectKey(_key: string): StreamingSchemaNode {
		return this;
	}
	childForArrayIndex(_index: number): StreamingSchemaNode {
		return this;
	}
}

class ScalarStreamingSchema implements StreamingSchemaNode {
	completeSchema: Schema.Schema<unknown>;
	streamingSchema: Schema.Schema.All;
	constructor(completeSchema: Schema.Schema<unknown>) {
		this.completeSchema = completeSchema;
		this.streamingSchema = declareStreamingSchema((node) =>
			isComplete(node) ? decodeComplete(this.completeSchema, node) : Effect.succeed(incomplete()),
		);
	}
}

class ObjectStreamingSchema implements StreamingSchemaNode {
	completeSchema: Schema.Schema<unknown>;
	properties: Map<string, StreamingSchemaNode>;
	indexValue: StreamingSchemaNode | null;
	streamingSchema: Schema.Schema.All;
	constructor(
		completeSchema: Schema.Schema<unknown>,
		properties: Map<string, StreamingSchemaNode>,
		indexValue: StreamingSchemaNode | null,
	) {
		this.completeSchema = completeSchema;
		this.properties = properties;
		this.indexValue = indexValue;
		this.streamingSchema = declareStreamingSchema((node) => {
			if (node._tag !== "object") {
				return isComplete(node) ? decodeComplete(this.completeSchema, node) : Effect.succeed(incomplete());
			}
			const duplicateIssue = findDuplicateKeyIssue(node);
			if (duplicateIssue) return Effect.fail(duplicateIssue);
			for (const [key, value] of node.entries) {
				const issue = decodeChild(this.childForObjectKey(key), value, key, node);
				if (issue) return Effect.fail(issue);
			}
			return node.state === "complete" ? decodeComplete(this.completeSchema, node) : Effect.succeed(incomplete());
		});
	}
	childForObjectKey(key: string): StreamingSchemaNode {
		return this.properties.get(key) ?? this.indexValue ?? UNKNOWN_STREAMING_SCHEMA;
	}
}

class TupleStreamingSchema implements StreamingSchemaNode {
	completeSchema: Schema.Schema<unknown>;
	elements: (StreamingSchemaNode | null)[];
	rest: StreamingSchemaNode | null;
	streamingSchema: Schema.Schema.All;
	constructor(
		completeSchema: Schema.Schema<unknown>,
		elements: (StreamingSchemaNode | null)[],
		rest: StreamingSchemaNode | null,
	) {
		this.completeSchema = completeSchema;
		this.elements = elements;
		this.rest = rest;
		this.streamingSchema = declareStreamingSchema((node) => {
			if (node._tag !== "array") {
				return isComplete(node) ? decodeComplete(this.completeSchema, node) : Effect.succeed(incomplete());
			}
			for (let index = 0; index < node.items.length; index += 1) {
				const child = this.childForArrayIndex(index);
				if (!child) continue;
				const issue = decodeChild(child, node.items[index], index, node);
				if (issue) return Effect.fail(issue);
			}
			return node.state === "complete" ? decodeComplete(this.completeSchema, node) : Effect.succeed(incomplete());
		});
	}
	childForArrayIndex(index: number): StreamingSchemaNode | null {
		return this.elements[index] ?? this.rest;
	}
}

class UnionStreamingSchema implements StreamingSchemaNode {
	completeSchema: Schema.Schema<unknown>;
	branches: StreamingSchemaNode[];
	streamingSchema: Schema.Schema.All;
	constructor(completeSchema: Schema.Schema<unknown>, branches: StreamingSchemaNode[]) {
		this.completeSchema = completeSchema;
		this.branches = branches;
		this.streamingSchema = declareStreamingSchema((node) => {
			switch (node._tag) {
				case "object": {
					const duplicateIssue = findDuplicateKeyIssue(node);
					if (duplicateIssue) return Effect.fail(duplicateIssue);
					for (const [key, value] of node.entries) {
						const child = this.childForObjectKey(key);
						if (!child) continue;
						const issue = decodeChild(child, value, key, node);
						if (issue) return Effect.fail(issue);
					}
					break;
				}
				case "array":
					for (let index = 0; index < node.items.length; index += 1) {
						const child = this.childForArrayIndex(index);
						if (!child) continue;
						const issue = decodeChild(child, node.items[index], index, node);
						if (issue) return Effect.fail(issue);
					}
					break;
				case "string":
				case "number":
					if (node.state !== "complete") return Effect.succeed(incomplete());
					break;
				case "boolean":
				case "null":
					break;
			}
			return node.state === "complete" ? decodeComplete(this.completeSchema, node) : Effect.succeed(incomplete());
		});
	}
	childForObjectKey(key: string): StreamingSchemaNode | null {
		return combineUnionChildren(
			this.branches.flatMap((branch) => {
				const child = branch.childForObjectKey?.(key) ?? null;
				return child === null ? [] : [child];
			}),
		);
	}
	childForArrayIndex(index: number): StreamingSchemaNode | null {
		return combineUnionChildren(
			this.branches.flatMap((branch) => {
				const child = branch.childForArrayIndex?.(index) ?? null;
				return child === null ? [] : [child];
			}),
		);
	}
}

function combineUnionChildren(children: StreamingSchemaNode[]): StreamingSchemaNode | null {
	if (children.length === 0) return null;
	if (children.some((child) => child.completeSchema === null)) return UNKNOWN_STREAMING_SCHEMA;
	if (children.length === 1) return children[0];
	return new UnionStreamingSchema(
		schemaFromAST(
			SchemaAST.Union.make(children.map((child) => (child.completeSchema as Schema.Schema<unknown>).ast)),
		),
		children,
	);
}

function deriveAST(ast: SchemaAST.AST, completeSchema: Schema.Schema<unknown>): StreamingSchemaNode {
	switch (ast._tag) {
		case "Refinement":
			return deriveAST(ast.from, completeSchema);
		case "Transformation":
			return deriveAST(ast.from, completeSchema);
		case "Suspend":
			return deriveAST(ast.f(), completeSchema);
		case "TypeLiteral": {
			const properties = new Map<string, StreamingSchemaNode>();
			for (const property of ast.propertySignatures) {
				properties.set(property.name as string, deriveAST(property.type, schemaFromAST(property.type)));
			}
			const indexValue = ast.indexSignatures[0]
				? deriveAST(ast.indexSignatures[0].type, schemaFromAST(ast.indexSignatures[0].type))
				: null;
			return new ObjectStreamingSchema(completeSchema, properties, indexValue);
		}
		case "TupleType": {
			const elements = ast.elements.map((element) => deriveAST(element.type, schemaFromAST(element.type)));
			const rest = ast.rest[0] ? deriveAST(ast.rest[0].type, schemaFromAST(ast.rest[0].type)) : null;
			return new TupleStreamingSchema(completeSchema, elements, rest);
		}
		case "Union":
			return new UnionStreamingSchema(
				completeSchema,
				ast.types.map((member) => deriveAST(member, schemaFromAST(member))),
			);
		default:
			return new ScalarStreamingSchema(completeSchema);
	}
}

export function deriveStreamingSchema(schema: Schema.Schema<unknown>): Schema.Schema<unknown> {
	return deriveAST(schema.ast, schema).streamingSchema as unknown as Schema.Schema<unknown>;
}

const UNKNOWN_STREAMING_SCHEMA = new UnknownStreamingSchema();
