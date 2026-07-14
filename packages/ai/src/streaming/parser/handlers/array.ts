/**
 * Array handler for incremental JSON parser.
 */

import type { Frame, Op, ParsedValue } from "../machine.ts";
import type { Token } from "../tokenizer.ts";
import type { ParserCtx } from "../types.ts";
import { popAndAttach } from "./attach-child.ts";
import { buildScalar } from "./scalars.ts";

function buildArr(frame: Extract<Frame, { type: "array" }>): ParsedValue {
	return {
		_tag: "array",
		items: [...frame.items],
		state: "complete",
	};
}

export const arrayHandler = {
	handle(token: Token, frame: Extract<Frame, { type: "array" }>, ctx: ParserCtx): Op[] {
		switch (frame.phase) {
			case "expectValue": {
				if (token._tag === "arrayClose") {
					return popAndAttach(buildArr(frame), ctx.peekParent());
				}
				if (token._tag === "objectOpen") {
					return [{ type: "push", frame: { type: "object", keys: [], values: [], phase: "expectKey" } }];
				}
				if (token._tag === "arrayOpen") {
					return [{ type: "push", frame: { type: "array", items: [], phase: "expectValue" } }];
				}
				const val = buildScalar(token);
				if (val) {
					return [{ type: "replace", frame: { ...frame, items: [...frame.items, val], phase: "afterValue" } }];
				}
				return [];
			}
			case "afterValue": {
				if (token._tag === "comma") {
					return [{ type: "replace", frame: { ...frame, phase: "expectValue" } }];
				}
				if (token._tag === "arrayClose") {
					return popAndAttach(buildArr(frame), ctx.peekParent());
				}
				return [];
			}
		}
	},
};
