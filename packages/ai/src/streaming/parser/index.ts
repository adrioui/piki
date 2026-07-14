/**
 * Incremental JSON parser combining tokenizer + parser.
 */

import type { ParsedValue } from "./machine.ts";
import { createJsonParser } from "./parser.ts";
import { createJsonTokenizer } from "./tokenizer.ts";

export function createIncrementalJsonParser() {
	let isDone = false;
	const tokenizer = createJsonTokenizer((token) => parser.feed(token));
	const parser = createJsonParser(tokenizer);
	return {
		push(chunk: string) {
			tokenizer.push(chunk);
		},
		end() {
			tokenizer.end();
			parser.end();
			isDone = true;
		},
		get partial(): ParsedValue | undefined {
			return parser.partial;
		},
		get done(): boolean {
			return isDone;
		},
		get currentPath(): string[] {
			return parser.currentPath;
		},
	};
}

export type { ParsedValue };
