/**
 * Object handler for incremental JSON parser.
 */

import type { Frame, Op, ParsedValue } from "../machine.ts";
import type { Token } from "../tokenizer.ts";
import type { ParserCtx } from "../types.ts";
import { popAndAttach } from "./attach-child.ts";
import { buildScalar } from "./scalars.ts";

function entry(key: string, value: ParsedValue): [string, ParsedValue] {
	return [key, value];
}

function keyFromToken(token: Token): string | null {
	switch (token._tag) {
		case "string":
			return token.value;
		case "unquotedString":
			return token.value;
		case "true":
			return "true";
		case "false":
			return "false";
		case "null":
			return "null";
		default:
			return null;
	}
}

function buildObj(frame: Extract<Frame, { type: "object" }>, keyLimit?: number): ParsedValue {
	const keys = keyLimit !== undefined ? frame.keys.slice(0, keyLimit) : frame.keys;
	return {
		_tag: "object",
		entries: keys.map((k, i) => entry(k, frame.values[i])),
		state: "complete",
	};
}

export const objectHandler = {
	handle(token: Token, frame: Extract<Frame, { type: "object" }>, ctx: ParserCtx): Op[] {
		switch (frame.phase) {
			case "expectKey": {
				if (token._tag === "objectClose") {
					return popAndAttach(buildObj(frame), ctx.peekParent());
				}
				const key = keyFromToken(token);
				if (key !== null) {
					return [{ type: "replace", frame: { ...frame, keys: [...frame.keys, key], phase: "expectColon" } }];
				}
				return [];
			}
			case "expectColon": {
				if (token._tag === "colon") {
					return [{ type: "replace", frame: { ...frame, phase: "expectValue" } }];
				}
				return [];
			}
			case "expectValue": {
				if (token._tag === "objectOpen") {
					return [{ type: "push", frame: { type: "object", keys: [], values: [], phase: "expectKey" } }];
				}
				if (token._tag === "arrayOpen") {
					return [{ type: "push", frame: { type: "array", items: [], phase: "expectValue" } }];
				}
				if (token._tag === "objectClose") {
					return popAndAttach(buildObj(frame, frame.values.length), ctx.peekParent());
				}
				const val = buildScalar(token);
				if (val) {
					return [{ type: "replace", frame: { ...frame, values: [...frame.values, val], phase: "afterValue" } }];
				}
				return [];
			}
			case "afterValue": {
				if (token._tag === "comma") {
					return [{ type: "replace", frame: { ...frame, phase: "expectKey" } }];
				}
				if (token._tag === "objectClose") {
					return popAndAttach(buildObj(frame), ctx.peekParent());
				}
				return [];
			}
		}
	},
};
