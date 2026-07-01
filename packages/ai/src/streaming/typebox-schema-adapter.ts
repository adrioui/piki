/**
 * Typebox schema adapter for streaming validation.
 * Converts Typebox schemas (which ARE JSON Schema) into a streaming-friendly format.
 * Validates partial JSON against the schema during streaming.
 *
 * Validation rules:
 * - Don't fail on missing required fields (stream is incomplete)
 * - DO fail on wrong-type fields (string where number expected)
 * - DO fail on enum violations (value not in allowed set)
 *
 * Typebox optionality is represented by the parent object's `required` array,
 * not by metadata on the child schema.
 */

import type { TSchema } from "typebox";

export interface StreamingSchemaField {
	name: string;
	type: "string" | "number" | "boolean" | "object" | "array" | "union" | "null" | "any";
	required: boolean;
	children?: StreamingSchemaField[];
	itemSchema?: StreamingSchemaField;
	tupleItems?: StreamingSchemaField[];
	additionalProperties?: StreamingSchemaField;
	enumValues?: string[];
}

export interface ValidationState {
	valid: boolean;
	issue?: string;
	fieldPath?: string;
}

export function typeboxToStreamingSchema(
	schema: TSchema,
	name = "root",
	parentRequired?: readonly string[],
): StreamingSchemaField {
	const type = (schema as { type?: string | string[] }).type;
	const required = parentRequired ? parentRequired.includes(name) : true;
	const fields: StreamingSchemaField[] = [];

	const allOf = (schema as { allOf?: TSchema[] }).allOf;
	if (allOf && allOf.length > 0) {
		return typeboxToStreamingSchema(mergeObjectSchemas(allOf), name, parentRequired);
	}

	const patternProperties = (schema as { patternProperties?: Record<string, TSchema> }).patternProperties;
	if (patternProperties && Object.keys(patternProperties).length > 0) {
		const valueSchema = Object.values(patternProperties)[0];
		return {
			name,
			type: "object",
			required,
			children: [],
			additionalProperties: valueSchema ? typeboxToStreamingSchema(valueSchema, "*") : undefined,
		};
	}

	if (type === "object" || (schema as { properties?: unknown }).properties) {
		const properties = (schema as { properties?: Record<string, TSchema> }).properties;
		if (properties) {
			const childRequired = (schema as { required?: string[] }).required ?? [];
			for (const key of Object.keys(properties)) {
				fields.push(typeboxToStreamingSchema(properties[key]!, key, childRequired));
			}
		}
		return {
			name,
			type: "object",
			required,
			children: fields,
		};
	}

	if (type === "array" || (schema as { items?: unknown }).items) {
		const items = (schema as { items?: TSchema | TSchema[] }).items;
		if (Array.isArray(items)) {
			return {
				name,
				type: "array",
				required,
				tupleItems: items.map((item, index) => typeboxToStreamingSchema(item, `${name}[${index}]`)),
			};
		}
		return {
			name,
			type: "array",
			required,
			itemSchema: items ? typeboxToStreamingSchema(items, `${name}[]`) : undefined,
		};
	}

	if (Array.isArray(type)) {
		return {
			name,
			type: "union",
			required,
			children: type.map((t) => ({
				name: `${name}.${t}`,
				type: normalizeSchemaType(t as string),
				required: true,
			})),
		};
	}

	// Detect unions of literals (Type.Union([Type.Literal(...), ...]) → anyOf)
	const anyOf = (schema as { anyOf?: TSchema[] }).anyOf;
	if (anyOf && anyOf.length > 0) {
		const literals = anyOf.map((s) => (s as { const?: unknown }).const).filter((v) => v !== undefined);
		if (literals.length === anyOf.length) {
			return {
				name,
				type: "string",
				required,
				enumValues: literals.map(String),
			};
		}
		return {
			name,
			type: "union",
			required,
			children: anyOf.map((s) => typeboxToStreamingSchema(s, `${name}_item`)),
		};
	}

	const enumValues = (schema as { enum?: unknown[] }).enum;
	if (enumValues) {
		return {
			name,
			type: normalizeSchemaType(type),
			required,
			enumValues: enumValues.map(String),
		};
	}

	return {
		name,
		type: normalizeSchemaType(type),
		required,
	};
}

function normalizeSchemaType(type: string | string[] | undefined): StreamingSchemaField["type"] {
	if (Array.isArray(type)) return "union";
	if (type === "integer") return "number";
	if (
		type === "string" ||
		type === "number" ||
		type === "boolean" ||
		type === "object" ||
		type === "array" ||
		type === "union" ||
		type === "null" ||
		type === "any"
	) {
		return type;
	}
	return "any";
}

export function validatePartialAgainstSchema(
	partial: unknown,
	schema: StreamingSchemaField,
	path = schema.name,
): ValidationState {
	if (partial === undefined || partial === null) {
		return { valid: true };
	}

	if (schema.type === "object" && schema.children) {
		if (typeof partial !== "object" || Array.isArray(partial)) {
			return { valid: false, issue: `Field "${path}" expected type object`, fieldPath: path };
		}
		const obj = partial as Record<string, unknown>;
		const namedChildren = new Set(schema.children.map((child) => child.name));
		for (const child of schema.children) {
			if (!(child.name in obj)) {
				continue;
			}
			const result = validatePartialAgainstSchema(
				obj[child.name],
				child,
				path === "root" ? child.name : `${path}.${child.name}`,
			);
			if (!result.valid) return result;
		}
		if (schema.additionalProperties) {
			for (const [key, value] of Object.entries(obj)) {
				if (namedChildren.has(key)) continue;
				const result = validatePartialAgainstSchema(
					value,
					schema.additionalProperties,
					path === "root" ? key : `${path}.${key}`,
				);
				if (!result.valid) return result;
			}
		} else {
			for (const key of Object.keys(obj)) {
				if (!namedChildren.has(key)) {
					return {
						valid: false,
						issue: `Unknown field: ${path === "root" ? key : `${path}.${key}`}`,
						fieldPath: path === "root" ? key : `${path}.${key}`,
					};
				}
			}
		}
		return { valid: true };
	}

	if (schema.type === "array" && schema.tupleItems) {
		if (!Array.isArray(partial)) {
			return { valid: false, issue: `Field "${path}" expected type array`, fieldPath: path };
		}
		if (partial.length > schema.tupleItems.length) {
			return {
				valid: false,
				issue: `Field "${path}" expected tuple length ${schema.tupleItems.length}`,
				fieldPath: path,
			};
		}
		for (let i = 0; i < partial.length; i++) {
			const itemSchema = schema.tupleItems[i];
			if (!itemSchema) continue;
			const result = validatePartialAgainstSchema(partial[i], itemSchema, `${path}[${i}]`);
			if (!result.valid) return result;
		}
		return { valid: true };
	}

	if (schema.type === "array" && schema.itemSchema) {
		if (!Array.isArray(partial)) {
			return { valid: false, issue: `Field "${path}" expected type array`, fieldPath: path };
		}
		for (let i = 0; i < partial.length; i++) {
			const item = partial[i];
			const result = validatePartialAgainstSchema(item, schema.itemSchema, `${path}[${i}]`);
			if (!result.valid) return result;
		}
		return { valid: true };
	}

	if (schema.type === "union" && schema.children) {
		const results = schema.children.map((child) => validatePartialAgainstSchema(partial, child, path));
		if (results.some((result) => result.valid)) return { valid: true };
		const errors = results
			.filter((r) => !r.valid)
			.map((r) => r.issue)
			.filter(Boolean);
		return {
			valid: false,
			issue:
				errors.length > 0
					? `Field "${path}" did not match any union branch: ${errors.join("; ")}`
					: `Field "${path}" did not match any union branch`,
			fieldPath: path,
		};
	}

	if (schema.enumValues) {
		const value = String(partial);
		if (!schema.enumValues.includes(value)) {
			return {
				valid: false,
				issue: `Field "${path}" must be one of: ${schema.enumValues.join(", ")}`,
				fieldPath: path,
			};
		}
		return { valid: true };
	}

	if (schema.type === "string" && typeof partial !== "string") {
		return { valid: false, issue: `Field "${path}" expected type string, got ${typeof partial}`, fieldPath: path };
	}
	if (schema.type === "number" && typeof partial !== "number") {
		return { valid: false, issue: `Field "${path}" expected type number, got ${typeof partial}`, fieldPath: path };
	}
	if (schema.type === "boolean" && typeof partial !== "boolean") {
		return { valid: false, issue: `Field "${path}" expected type boolean, got ${typeof partial}`, fieldPath: path };
	}

	return { valid: true };
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
