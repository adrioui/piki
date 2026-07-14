/**
 * Token-cost estimation helpers for compaction/truncation decisions.
 *
 * ts ().
 * Tokens approximate chars/4 to match pi's compaction.ts:224 + faux.ts:140.
 *
 * NOTE: For whole-message estimation in compaction use
 * `compaction.ts:estimateTokens(message: AgentMessage)` (chars/4 by role).
 * Use `estimateCompletedTurn` only when you specifically need the
 * per-turn aggregate (assistant reasoning + tool calls + per-result detail
 * + feedback). G22's value-add over pi's existing estimator is the
 * **per-tool-result truncation collapse** (huge success → describeShape + 50),
 * which pi does not have.
 */

/** Characters attributed to an image block in content arrays. Aligns with compaction.ts:205. */
export const ESTIMATED_IMAGE_CHARS = 4800;

/** Token limit above which expensive results collapse to shape-only + overhead. */
export const TRUNCATION_TOKEN_LIMIT = 2_000;

/** Estimate tokens for a plain text input. chars/4 matches pi's faux.ts:140 and compaction.ts:224. */
export function estimateText(input: string): number {
	return Math.ceil(input.length / 4);
}

/**
 * Deterministic short shape string for large outputs.
 * Objects → keys (cap 8), arrays → length + head shape, primitives → typeof.
 * Depth-capped at 3. Yields <1 KB even for huge payloads.
 */
export function describeShape(value: unknown, depth = 0): string {
	if (value === null) return "null";
	if (Array.isArray(value)) {
		if (depth >= 3) return "[…]";
		const head = value.length > 0 ? describeShape(value[0], depth + 1) : "∅";
		return `[len=${value.length}, ${head}]`;
	}
	if (typeof value === "object") {
		if (depth >= 3) return "{…}";
		const keys = Object.keys(value as object);
		return `{${keys.slice(0, 8).join(",")}${keys.length > 8 ? ",…" : ""}}`;
	}
	return typeof value;
}

/** Render user feedback to a string for token estimation. */
export function renderFeedbackText(feedback: unknown): string {
	if (typeof feedback === "string") return feedback;
	if (feedback === undefined) return "";
	return JSON.stringify(feedback);
}

/* ---- Tagged (verbatim) ---- */

export interface ResultTag {
	readonly _tag: "Success" | "Error" | "Denied" | "Interrupted" | "InputRejected";
	readonly output?: unknown;
	readonly error?: { message?: string };
	readonly denial?: string | object;
	readonly partialInput?: unknown;
}

/**
 * Estimate tokens for a tagged result. Pure reference-capture switch.
 * Huge success outputs collapse to shape + 50 tokens.
 */
export function estimateResultTokensTagged(result: ResultTag): number {
	switch (result._tag) {
		case "Success": {
			if (result.output === undefined) return 10;
			try {
				const serialized = JSON.stringify(result.output);
				const est = estimateText(serialized);
				if (est > TRUNCATION_TOKEN_LIMIT) return estimateText(describeShape(result.output)) + 50;
				return est;
			} catch {
				return 50;
			}
		}
		case "Error":
			return estimateText(result.error?.message ?? "") + 30;
		case "Denied":
			return (
				estimateText(typeof result.denial === "string" ? result.denial : JSON.stringify(result.denial ?? "")) + 30
			);
		case "Interrupted":
			return 10;
		case "InputRejected":
			return estimateText(JSON.stringify(result.partialInput ?? "")) + 80;
	}
}

/* ---- Pi-flavoured (AgentToolResult shape) ---- */

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

/**
 * Estimate tokens for a result matching pi's AgentToolResult shape.
 *
 * pi's ACTUAL AgentToolResult<T> (packages/agent/src/types.ts:369) is:
 * { content: (TextContent|ImageContent)[], details: T, terminate?: boolean }
 * Tools THROW on failure instead of encoding errors in the result.
 *
 * This function estimates the token cost of the content + details blocks.
 * For each content block: text.length for text blocks, ESTIMATED_IMAGE_CHARS
 * for image/other blocks. Then adds safe-stringified details length.
 * Returns Math.ceil(totalChars / 4).
 */
export function estimateAgentToolResult(result: {
	content: Array<{ type: string; text?: string }>;
	details: unknown;
}): number {
	let totalChars = 0;
	for (const block of result.content) {
		if (block.type === "text" && block.text) {
			totalChars += block.text.length;
		} else {
			totalChars += ESTIMATED_IMAGE_CHARS;
		}
	}
	totalChars += safeStringify(result.details).length;
	return Math.ceil(totalChars / 4);
}

/* ---- Completed turn (reference-capture verbatim) ---- */

export interface CompletedTurnLike {
	readonly assistant: {
		reasoning?: string;
		text?: string;
		toolCalls?: { name: string; input: unknown }[];
	};
	readonly toolResults: { result: ResultTag }[];
	readonly feedback?: unknown;
}

/**
 * Estimate total tokens for one completed assistant turn.
 *
 * NOTE: pi's compaction.ts:estimateTokens already covers whole-message
 * estimation. This function is for reference-capture-style per-turn aggregates
 * (assistant reasoning + tool calls + per-result detail + feedback).
 */
export function estimateCompletedTurn(turn: CompletedTurnLike): number {
	let tokens = 0;
	tokens += estimateText(turn.assistant.reasoning ?? "");
	tokens += estimateText(turn.assistant.text ?? "");
	if (turn.assistant.toolCalls) {
		for (const tc of turn.assistant.toolCalls) {
			tokens += estimateText(tc.name) + estimateText(JSON.stringify(tc.input)) + 20;
		}
	}
	for (const entry of turn.toolResults) {
		tokens += estimateResultTokensTagged(entry.result);
	}
	tokens += estimateText(renderFeedbackText(turn.feedback));
	return tokens;
}
