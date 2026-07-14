/**
 * Handler binding for incremental JSON parser.
 */

import type { Frame, Op, ParsedValue } from "./machine.ts";
import type { Token } from "./tokenizer.ts";

export interface ParserCtx {
	tokenizer: { pending: { _tag: string; content: string } | null };
	peekParent(): Frame | undefined;
}

export interface BoundHandler {
	handle(token: Token, ctx: ParserCtx): Op[];
}

export interface Handler {
	handle(token: Token, frame: Frame, ctx: ParserCtx): Op[];
}

export function bindHandler(handler: Handler, frame: Frame): BoundHandler {
	return {
		handle: (token, ctx) => handler.handle(token, frame, ctx),
	};
}

export type { Frame, ParsedValue, Token };
