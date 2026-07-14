/**
 * Streaming field parser with schema validation.
 * Used by the NativeChatCompletions codec.
 */

import { ParseResult, Schema } from "effect";
import { createIncrementalJsonParser } from "./parser/index.ts";
import type { ParsedValue } from "./parser/machine.ts";
import { deriveStreamingSchema } from "./streaming-schema.ts";
import { parsedValueToJson, parsedValueToStreamingPartial } from "./values.ts";

export type FieldEvent =
	| { _tag: "field_start"; path: string[] }
	| { _tag: "field_delta"; path: string[]; delta: string }
	| { _tag: "field_end"; path: string[]; value: unknown };

const UNDECODED = { _tag: "Undecoded" as const };

export function walkAndDiff(
	node: ParsedValue,
	path: string[],
	snapshot: Map<string, { seenText: string; complete: boolean }>,
	events: FieldEvent[],
) {
	const key = path.join("\0");
	let state = snapshot.get(key);
	if (!state) {
		events.push({ _tag: "field_start", path });
		state = { seenText: "", complete: false };
		snapshot.set(key, state);
	}
	if (node._tag === "object") {
		for (const [childKey, childValue] of node.entries) {
			walkAndDiff(childValue, [...path, childKey], snapshot, events);
		}
	} else if (node._tag === "array") {
		for (let index = 0; index < node.items.length; index += 1) {
			walkAndDiff(node.items[index], [...path, String(index)], snapshot, events);
		}
	} else if (node._tag === "string" || node._tag === "number") {
		if (node.value.length > state.seenText.length) {
			const delta = node.value.slice(state.seenText.length);
			events.push({ _tag: "field_delta", path, delta });
			state.seenText = node.value;
		}
	}
	if (node.state === "complete" && !state.complete) {
		events.push({ _tag: "field_end", path, value: parsedValueToJson(node) });
		state.complete = true;
	}
}

export function createStreamingFieldParser(schema?: Schema.Schema<unknown>) {
	const jsonParser = createIncrementalJsonParser();
	const snapshot = new Map<string, { seenText: string; complete: boolean }>();
	const streamingSchema = schema ? deriveStreamingSchema(schema) : null;
	const decodeStreaming = streamingSchema ? Schema.decodeUnknownEither(streamingSchema) : null;
	let validation:
		| { _tag: "Valid"; decoded: { _tag: "Undecoded" } | { _tag: "Decoded"; value: unknown } }
		| { _tag: "Invalid"; issue: { path: string[]; message: string } } = { _tag: "Valid", decoded: UNDECODED };

	function formatValidationIssue(result: ParseResult.ParseError): { path: string[]; message: string } {
		const issues = ParseResult.ArrayFormatter.formatErrorSync(result);
		if (issues.length === 0) {
			return { path: [], message: result.message };
		}
		return { path: issues[0].path.map(String), message: issues[0].message };
	}

	function markInvalid(result: ParseResult.ParseError) {
		validation = { _tag: "Invalid", issue: formatValidationIssue(result) };
	}

	function validatePartial() {
		if (!decodeStreaming || validation._tag === "Invalid") return;
		const partial = jsonParser.partial;
		if (!partial) return;
		const result = decodeStreaming(partial);
		if (result._tag === "Left") {
			markInvalid(result.left);
			return;
		}
		const decoded = result.right as { _tag: "Incomplete" } | { _tag: "Complete"; value: unknown };
		validation =
			decoded._tag === "Complete"
				? { _tag: "Valid", decoded: { _tag: "Decoded", value: decoded.value } }
				: { _tag: "Valid", decoded: UNDECODED };
	}

	function validateEnd() {
		if (!decodeStreaming || validation._tag === "Invalid") return;
		validatePartial();
		if (validation._tag === "Valid" && validation.decoded._tag === "Undecoded") {
			validation = {
				_tag: "Invalid",
				issue: {
					path: jsonParser.currentPath,
					message: "Input ended before the root value completed",
				},
			};
		}
	}

	function diffPartial(): FieldEvent[] {
		const events: FieldEvent[] = [];
		const partial = jsonParser.partial;
		if (partial !== undefined) {
			walkAndDiff(partial, [], snapshot, events);
		}
		return events;
	}

	return {
		push(chunk: string): FieldEvent[] {
			jsonParser.push(chunk);
			const events = diffPartial();
			validatePartial();
			return events;
		},
		end(): FieldEvent[] {
			jsonParser.end();
			const events = diffPartial();
			validateEnd();
			return events;
		},
		get partial(): unknown {
			const p = jsonParser.partial;
			if (p === undefined) return undefined;
			return parsedValueToStreamingPartial(p);
		},
		get decoded(): unknown {
			if (validation._tag !== "Valid" || validation.decoded._tag !== "Decoded") return null;
			return validation.decoded.value;
		},
		get valid(): boolean {
			return validation._tag === "Valid";
		},
		get validationIssue(): { path: string[]; message: string } | null {
			return validation._tag === "Invalid" ? validation.issue : null;
		},
	};
}
