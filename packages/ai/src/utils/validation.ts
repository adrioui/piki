import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

/**
 * Mirror of Magnitude alpha22's `toolfix.go` normalization. Runs *before* the
 * schema-driven `validateToolArguments` coercion: it repairs model output that
 * the generic JSON-schema coercion cannot (status-enum synonyms, object-encoded
 * arrays, required-field injection). This is what lets piki silently survive the
 * same malformed tool calls that alpha22's proxy repairs.
 */

/** Per-tool numeric fields that must be coerced from string → number. */
const TOOLFIX_NUMERIC_FIELDS: Record<string, readonly string[]> = {
	read: ["offset", "limit"],
	grep: ["limit"],
	tree: ["maxDepth"],
	shell: ["detach_after"],
	bash: ["detach_after"],
};

/** Per-tool boolean fields that must be coerced from string → boolean. */
const TOOLFIX_BOOLEAN_FIELDS: Record<string, readonly string[]> = {
	edit: ["replaceAll"],
	tree: ["recursive", "gitignore"],
	spawn_worker: ["yield"],
	spawnWorker: ["yield"],
};

/** Normalizes `update_task.status` synonyms to alpha22's canonical set. */
function normalizeStatus(value: string): string {
	switch (value) {
		case "pending":
		case "completed":
		case "cancelled":
			return value;
		case "working":
		case "in_progress":
		case "active":
		case "started":
			return "pending";
		case "done":
		case "complete":
		case "finished":
			return "completed";
		case "canceled":
			return "cancelled";
		default:
			return value;
	}
}

/**
 * Repairs models that encode a JSON array as an object with contiguous numeric
 * string keys (e.g. `{"0":"a","1":"b"}`). Invalid or sparse objects are returned
 * unchanged so that downstream validation can reject them rather than losing data.
 */
function indexedStringObjectToArray(value: unknown): unknown {
	const obj = value as Record<string, unknown> | undefined;
	if (typeof obj !== "object" || obj === null || Array.isArray(obj) || Object.keys(obj).length === 0) {
		return value;
	}
	const out: unknown[] = new Array(Object.keys(obj).length);
	for (let i = 0; i < out.length; i++) {
		if (!(String(i) in obj)) {
			return value;
		}
		const item = obj[String(i)];
		if (typeof item !== "string") {
			return value;
		}
		out[i] = item;
	}
	return out;
}

function numericStringToNumber(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (trimmed.length >= 15) return value;
	if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return value;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : value;
}

function stringToBool(value: unknown): unknown {
	if (typeof value !== "string") return value;
	switch (value.trim().toLowerCase()) {
		case "true":
			return true;
		case "false":
			return false;
		default:
			return value;
	}
}

/**
 * Pre-validation coercion matching Magnitude alpha22 `toolfix.go::normalizeToolArgs`.
 *
 * Applies toolfix-style repairs on top of whatever the model emitted:
 * - string → number for known numeric params (offset/limit/maxDepth/detach_after)
 * - string → bool for known boolean params (replaceAll/recursive/gitignore/yield)
 * - `update_task.status` synonym normalization
 * - `compact.files` object-encoded array repair
 * - `compact.reflection` default injection ("" when absent)
 *
 * @param toolName The tool being invoked (wire name, snake or camel case)
 * @param params   The raw arguments object from the model
 * @returns A repaired copy of `params` (input is never mutated)
 */
export function coerceToolArgs(toolName: string, params: unknown): unknown {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		return params;
	}
	const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };

	for (const field of TOOLFIX_NUMERIC_FIELDS[toolName] ?? []) {
		if (field in out) {
			out[field] = numericStringToNumber(out[field]);
		}
	}
	for (const field of TOOLFIX_BOOLEAN_FIELDS[toolName] ?? []) {
		if (field in out) {
			out[field] = stringToBool(out[field]);
		}
	}

	if (toolName === "update_task" || toolName === "updateTask") {
		const status = out.status;
		if (typeof status === "string") {
			out.status = normalizeStatus(status.trim());
		}
	}

	if (toolName === "compact") {
		if ("files" in out) {
			out.files = indexedStringObjectToArray(out.files);
		}
		if (!("reflection" in out)) {
			out.reflection = "";
		}
	}

	return out;
}

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	items?: JsonSchemaObject | JsonSchemaObject[];
	additionalProperties?: boolean | JsonSchemaObject;
	allOf?: JsonSchemaObject[];
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
}

function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") {
		return [schema.type];
	}
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return false;
	}
}

function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
	try {
		return getValidator(schema as Tool["parameters"]);
	} catch {
		return undefined;
	}
}

function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "integer": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isInteger(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "boolean": {
			if (value === null) {
				return false;
			}
			if (typeof value === "string") {
				if (value === "true") {
					return true;
				}
				if (value === "false") {
					return false;
				}
			}
			if (typeof value === "number") {
				if (value === 1) {
					return true;
				}
				if (value === 0) {
					return false;
				}
			}
			return value;
		}
		case "string": {
			if (value === null) {
				return "";
			}
			if (typeof value === "number" || typeof value === "boolean") {
				return String(value);
			}
			return value;
		}
		case "null": {
			if (value === "" || value === 0 || value === false) {
				return null;
			}
			return value;
		}
		default:
			return value;
	}
}

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
	const properties = schema.properties;
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(value[key], propertySchema);
		}
	}

	if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
		}
	}
}

function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (!itemSchema) {
				continue;
			}
			value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}
		return;
	}

	if (schema.items && typeof schema.items === "object") {
		for (let index = 0; index < value.length; index++) {
			value[index] = coerceWithJsonSchema(value[index], schema.items);
		}
	}
}

function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
	for (const schema of schemas) {
		const candidate = structuredClone(value);
		const coerced = coerceWithJsonSchema(candidate, schema);
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(coerced)) {
			return coerced;
		}
	}
	return value;
}

function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = value;

	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) {
			nextValue = coerceWithJsonSchema(nextValue, nested);
		}
	}

	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	}

	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	}

	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) {
		for (const schemaType of schemaTypes) {
			const candidate = coercePrimitiveByType(nextValue, schemaType);
			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}

	if (
		schemaTypes.includes("object") &&
		typeof nextValue === "object" &&
		nextValue !== null &&
		!Array.isArray(nextValue)
	) {
		applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
	}

	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}

	return nextValue;
}

function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const args = structuredClone(toolCall.arguments);
	Value.Convert(tool.parameters, args);

	// toolfix.go-style repairs (status synonyms, object-encoded arrays, required
	// field injection) that generic JSON-schema coercion cannot express.
	const repaired = coerceToolArgs(tool.name, args as Record<string, unknown>);
	if (repaired !== args) {
		for (const key of Object.keys(args)) delete args[key];
		Object.assign(args, repaired);
	}

	const validator = getValidator(tool.parameters);
	if (!Object.getOwnPropertySymbols(tool.parameters).includes(TYPEBOX_KIND)) {
		const coerced = coerceWithJsonSchema(args, tool.parameters as JsonSchemaObject);
		if (coerced !== args) {
			if (typeof args === "object" && args !== null && typeof coerced === "object" && coerced !== null) {
				for (const key of Object.keys(args)) {
					delete args[key];
				}
				Object.assign(args, coerced);
			} else {
				return validator.Check(coerced) ? coerced : args;
			}
		}
	}

	if (validator.Check(args)) {
		return args;
	}

	const errors =
		validator
			.Errors(args)
			.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
			.join("\n") || "Unknown validation error";

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}
