/**
 * Tool error classification.
 *
 * Provider errors already flow through `@piki/ai`'s `classify.ts`, but tool
 * execution errors are flattened to a plain string via `createErrorToolResult`.
 * This module mirrors the shape of that classifier (explicit category tag +
 * retryable flag) so tool failures reach the model with structured recovery
 * guidance, without pulling HTTP/streaming-specific logic into the agent runtime.
 *
 * The idioms follow effect.solutions guidance (discriminated category, explicit
 * tags, exhaustive handling) without introducing the Effect runtime here.
 */

/** Classified category for a tool failure. */
export type ToolErrorCategory =
	| "timeout"
	| "permission"
	| "filesystem"
	| "network"
	| "invalid_args"
	| "aborted"
	| "unknown";

/** Structured info about a tool failure, surfaced to the model. */
export interface ToolErrorInfo {
	category: ToolErrorCategory;
	/** Human text shown to the model (the error message itself). */
	message: string;
	/** Hint for the model: whether retrying the same call is likely to help. */
	retryable: boolean;
	/** Recovery guidance shown to the model. */
	hint: string;
	/** Set for the `timeout` category: the deadline that elapsed (ms). */
	timedOutMs?: number;
}

/** Thrown internally when a tool exceeds its execution timeout. */
export class ToolTimeoutError extends Error {
	public readonly timedOutMs: number;

	constructor(timedOutMs: number) {
		super(`Tool timed out after ${Math.round(timedOutMs / 1000)}s`);
		this.name = "ToolTimeoutError";
		this.timedOutMs = timedOutMs;
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return String(error);
}

/** Classify a tool error into a structured {@link ToolErrorInfo}. */
export function classifyToolError(error: unknown, context: { toolName: string; timedOutMs?: number }): ToolErrorInfo {
	if (context.timedOutMs !== undefined) {
		return {
			category: "timeout",
			message: `Tool "${context.toolName}" timed out after ${Math.round(context.timedOutMs / 1000)}s`,
			retryable: false,
			hint: "Retry with a tighter scope, a shorter command, or split the work. If it legitimately needs more time, the timeout is configurable per tool.",
			timedOutMs: context.timedOutMs,
		};
	}

	if (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.message === "aborted")
	) {
		return { category: "aborted", message: "Tool aborted", retryable: false, hint: "" };
	}

	const text = errorMessage(error);

	if (
		text.includes("Permission denied") ||
		text.includes("EACCES") ||
		text.includes("blocked") ||
		text.includes("not permitted")
	) {
		return {
			category: "permission",
			message: text,
			retryable: false,
			hint: "Use a permitted path or request approval for this operation.",
		};
	}

	if (text.includes("ENOENT") || text.includes("no such file") || text.includes("file or directory")) {
		return {
			category: "filesystem",
			message: text,
			retryable: false,
			hint: "Verify the path exists and is accessible before retrying.",
		};
	}

	if (
		text.includes("ETIMEDOUT") ||
		text.includes("ENOTFOUND") ||
		text.includes("ECONNREFUSED") ||
		text.includes("network") ||
		text.includes("ECONNRESET") ||
		text.includes("fetch failed")
	) {
		return {
			category: "network",
			message: text,
			retryable: true,
			hint: "Network error; retry shortly or check connectivity.",
		};
	}

	if (
		text.includes("invalid") ||
		text.includes("schema") ||
		text.includes("required") ||
		text.includes("must be") ||
		text.includes("does not match")
	) {
		return {
			category: "invalid_args",
			message: text,
			retryable: false,
			hint: "Re-check the tool arguments against the schema before retrying.",
		};
	}

	return {
		category: "unknown",
		message: text,
		retryable: false,
		hint: "Inspect the error and adjust your approach.",
	};
}

/** Build an error tool result carrying a classified {@link ToolErrorInfo}. */
export function createClassifiedToolResult(info: ToolErrorInfo): {
	content: Array<{ type: "text"; text: string }>;
	details: { toolError: ToolErrorInfo };
} {
	return {
		content: [{ type: "text", text: `<tool_error>${info.message}</tool_error>` }],
		details: { toolError: info },
	};
}

/** Build a timeout error tool result for a tool that exceeded its deadline. */
export function createTimeoutToolResult(
	toolName: string,
	timedOutMs: number,
): {
	content: Array<{ type: "text"; text: string }>;
	details: { toolError: ToolErrorInfo };
} {
	return createClassifiedToolResult(classifyToolError(new ToolTimeoutError(timedOutMs), { toolName, timedOutMs }));
}
