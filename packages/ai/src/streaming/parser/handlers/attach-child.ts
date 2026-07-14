/**
 * Pop-and-attach helper for incremental JSON parser.
 */

import type { Frame, Op, ParsedValue } from "../machine.ts";

export function popAndAttach(child: ParsedValue, parent: Frame | undefined): Op[] {
	const popOp: Op = { type: "pop" };
	const emitOp: Op = { type: "emit", event: { _tag: "value", value: child } };
	if (!parent) {
		return [popOp, emitOp];
	}
	switch (parent.type) {
		case "root": {
			const updated: Frame = { type: "root", value: child };
			return [popOp, { type: "replace", frame: updated }, emitOp];
		}
		case "object": {
			if (parent.phase !== "expectValue") {
				throw new Error(`Invariant violation: popAndAttach called with object parent in phase "${parent.phase}"`);
			}
			const updated: Frame = {
				type: "object",
				keys: parent.keys,
				values: [...parent.values, child],
				phase: "afterValue",
			};
			return [popOp, { type: "replace", frame: updated }, emitOp];
		}
		case "array": {
			if (parent.phase !== "expectValue") {
				throw new Error(`Invariant violation: popAndAttach called with array parent in phase "${parent.phase}"`);
			}
			const updated: Frame = {
				type: "array",
				items: [...parent.items, child],
				phase: "afterValue",
			};
			return [popOp, { type: "replace", frame: updated }, emitOp];
		}
	}
}
