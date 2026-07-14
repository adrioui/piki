import type { Schema } from "effect";
import type { ContentPart } from "../content.ts";
import type { HarnessTool } from "../tool/tool.ts";
import { isImageValue, renderTagged, renderToolOutput, toImagePart } from "./helpers.ts";
import { renderExpectedParams } from "./schema-render.ts";

/** Result tags produced by tool execution in the harness turn. */
export type ToolResultTag = "Success" | "Error" | "Denied" | "Interrupted" | "InputRejected";

/** A successful tool result. */
export interface SuccessResult {
	readonly _tag: "Success";
	readonly output: unknown;
}

/** A failed tool result. */
export interface ErrorResult {
	readonly _tag: "Error";
	readonly error: { readonly message: string };
}

/** A denied tool result. */
export interface DeniedResult {
	readonly _tag: "Denied";
	readonly denial: unknown;
}

/** An interrupted tool result. */
export interface InterruptedResult_ {
	readonly _tag: "Interrupted";
}

/** An input-rejected tool result. */
export interface InputRejectedResult {
	readonly _tag: "InputRejected";
	readonly issue: { readonly path: readonly string[]; readonly message: string };
	readonly partialInput: unknown;
}

/** Union of all tool results the formatter handles. */
export type ToolResultEntry = SuccessResult | ErrorResult | DeniedResult | InterruptedResult_ | InputRejectedResult;

/** An entry passed to the formatter: the tool name + its result. */
export interface ToolResultContext {
	readonly toolName: string;
	readonly result: ToolResultEntry;
}

type SchemaLookup = Map<string, HarnessTool["definition"]["inputSchema"]>;

/** Format a single tool result into ContentParts for prompt injection. Matches capture L77037-77055. */
function formatResult(result: ToolResultEntry, toolName: string, schemaLookup: SchemaLookup): ContentPart[] {
	switch (result._tag) {
		case "Success": {
			if (result.output === undefined) return [{ _tag: "TextPart", text: "(no output)" }];
			if (isImageValue(result.output)) return [toImagePart(result.output)];
			return renderToolOutput(result.output);
		}
		case "Error":
			return [{ _tag: "TextPart", text: `<tool_error>${result.error.message}</tool_error>` }];
		case "Denied":
			return renderTagged("denied", result.denial);
		case "Interrupted":
			return [{ _tag: "TextPart", text: "<tool_interrupted/>" }];
		case "InputRejected":
			return formatInputRejected(result, toolName, schemaLookup);
	}
}

/** Format an input-rejected result with expected params and received partial input. Matches capture L77057-77098. */
function formatInputRejected(result: InputRejectedResult, toolName: string, schemaLookup: SchemaLookup): ContentPart[] {
	const lines: string[] = ["<input_rejected>", "Tool input was rejected.", ""];

	if (result.issue.path.length > 0) {
		lines.push(`Parameter: ${result.issue.path.join(".")}`);
	}
	lines.push(`Problem: ${result.issue.message}`);
	lines.push("");

	const schema = schemaLookup.get(toolName);
	if (schema) {
		try {
			lines.push(renderExpectedParams(schema as Schema.Schema<unknown>));
		} catch {
			lines.push("(Parameter schema unavailable)");
		}
	} else {
		lines.push("(Parameter schema unavailable)");
	}

	lines.push("");
	lines.push("Received:");

	const text = lines.join("\n");
	const receivedParts = renderToolOutput(result.partialInput);
	const parts: ContentPart[] = [{ _tag: "TextPart", text }];
	for (const p of receivedParts) parts.push(p);
	parts.push({ _tag: "TextPart", text: "\n</input_rejected>" });
	return parts;
}

export type ToolResultFormatter = (entry: ToolResultContext) => ContentPart[];

/**
 * Create a tool result formatter from a toolkit.
 * Builds an internal schema lookup and returns a function that formats any tool result.
 * Matches capture L77031-77036.
 */
export function createToolResultFormatter(toolkit: {
	readonly keys: string[];
	readonly entries: Record<string, HarnessTool>;
}): ToolResultFormatter {
	const schemaLookup = new Map<string, HarnessTool["definition"]["inputSchema"]>();
	for (const key of toolkit.keys) {
		const entry = toolkit.entries[key]!;
		const definition = entry.definition;
		schemaLookup.set(definition.name, definition.inputSchema);
	}
	return (entry: ToolResultContext) => {
		return formatResult(entry.result, entry.toolName, schemaLookup);
	};
}
