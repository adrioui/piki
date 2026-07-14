/**
 * Root handler for incremental JSON parser.
 */

import type { Frame, Op } from "../machine.ts";
import type { Token } from "../tokenizer.ts";
import type { ParserCtx } from "../types.ts";
import { buildScalar } from "./scalars.ts";

export const rootHandler = {
	handle(token: Token, _frame: Frame, _ctx: ParserCtx): Op[] {
		switch (token._tag) {
			case "objectOpen":
				return [{ type: "push", frame: { type: "object", keys: [], values: [], phase: "expectKey" } }];
			case "arrayOpen":
				return [{ type: "push", frame: { type: "array", items: [], phase: "expectValue" } }];
			default: {
				const val = buildScalar(token);
				if (val) return [{ type: "replace", frame: { type: "root", value: val } }];
				return [];
			}
		}
	},
};
