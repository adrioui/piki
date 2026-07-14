/**
 * Scalar value builder from tokens.
 */

import type { ParsedValue } from "../machine.ts";
import type { Token } from "../tokenizer.ts";

export function buildScalar(token: Token): ParsedValue | null {
	switch (token._tag) {
		case "string":
			return { _tag: "string", value: token.value, state: token.complete ? "complete" : "incomplete" };
		case "number":
			return { _tag: "number", value: token.value, state: token.complete ? "complete" : "incomplete" };
		case "true":
			return { _tag: "boolean", value: true, state: "complete" };
		case "false":
			return { _tag: "boolean", value: false, state: "complete" };
		case "null":
			return { _tag: "null", state: "complete" };
		case "unquotedString":
			return { _tag: "string", value: token.value, state: token.complete ? "complete" : "incomplete" };
		default:
			return null;
	}
}
