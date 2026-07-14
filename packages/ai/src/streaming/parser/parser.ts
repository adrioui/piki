/**
 * JSON parser combining tokenizer + stack machine.
 */

import type { Frame, ParsedValue } from "./machine.ts";
import { createStackMachine } from "./machine.ts";
import { resolveHandler } from "./resolve.ts";
import type { Token } from "./tokenizer.ts";
import type { ParserCtx } from "./types.ts";

function pendingToParsedValue(pending: { _tag: string; content: string }): ParsedValue {
	switch (pending._tag) {
		case "string":
			return { _tag: "string", value: pending.content, state: "incomplete" };
		case "number":
			return { _tag: "number", value: pending.content, state: "incomplete" };
		case "keyword":
			return { _tag: "string", value: pending.content, state: "incomplete" };
		case "unquoted":
			return { _tag: "string", value: pending.content, state: "incomplete" };
		default:
			return { _tag: "string", value: pending.content, state: "incomplete" };
	}
}

export function createJsonParser(tokenizer: { pending: { _tag: string; content: string } | null }) {
	const initialFrame: Frame = { type: "root", value: undefined };
	const machine = createStackMachine(initialFrame, () => {});
	const ctx: ParserCtx = {
		tokenizer,
		peekParent() {
			const s = machine.stack;
			return s.length >= 2 ? s[s.length - 2] : undefined;
		},
	};

	function feed(token: Token) {
		const top = machine.peek();
		if (!top) return;
		const handler = resolveHandler(top);
		const ops = handler.handle(token, ctx);
		machine.apply(ops);
	}

	function buildPartial(): ParsedValue | undefined {
		const stack = machine.stack;
		if (stack.length === 0) return undefined;
		const pending = tokenizer.pending;
		let pendingValue: ParsedValue | null = null;
		if (pending !== null) {
			pendingValue = pendingToParsedValue(pending);
		}
		if (stack.length === 1) {
			const bottom = stack[0];
			if (bottom.type !== "root") return undefined;
			if (pendingValue !== null && bottom.value === undefined) return pendingValue;
			return bottom.value;
		}
		let innerValue: ParsedValue | undefined = pendingValue ?? undefined;
		for (let i = stack.length - 1; i >= 0; i--) {
			const frame = stack[i];
			switch (frame.type) {
				case "root": {
					return innerValue ?? frame.value;
				}
				case "object": {
					const entries: Array<[string, ParsedValue]> = [];
					for (let ki = 0; ki < frame.keys.length; ki++) {
						if (ki < frame.values.length) {
							entries.push([frame.keys[ki], frame.values[ki]]);
						} else if (innerValue !== undefined) {
							entries.push([frame.keys[ki], innerValue]);
						}
					}
					innerValue = {
						_tag: "object",
						entries,
						state: "incomplete",
					};
					break;
				}
				case "array": {
					const items = [...frame.items];
					if (innerValue !== undefined) {
						items.push(innerValue);
					}
					innerValue = {
						_tag: "array",
						items,
						state: "incomplete",
					};
					break;
				}
			}
		}
		return innerValue;
	}

	function buildCurrentPath(): string[] {
		const path: string[] = [];
		const stack = machine.stack;
		for (let i = 1; i < stack.length; i++) {
			const frame = stack[i];
			switch (frame.type) {
				case "object": {
					if (frame.keys.length > 0) {
						path.push(frame.keys[frame.keys.length - 1]);
					}
					break;
				}
				case "array": {
					if (frame.phase === "afterValue") {
						path.push(String(frame.items.length - 1));
					} else if (frame.phase === "expectValue") {
						if (frame.items.length > 0 || (i === stack.length - 1 && tokenizer.pending !== null)) {
							path.push(String(frame.items.length));
						}
					}
					break;
				}
				case "root":
					break;
			}
		}
		return path;
	}

	return {
		feed,
		end() {},
		get partial(): ParsedValue | undefined {
			return buildPartial();
		},
		get currentPath(): string[] {
			return buildCurrentPath();
		},
	};
}
