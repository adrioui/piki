import type { ImageContent, TextContent } from "@piki/ai";
import { DEFAULT_CONTEXT_WINDOW, proportionalToolOutputBytes } from "./context-budget.ts";

export interface ToolResultForModel {
	content: (TextContent | ImageContent)[];
	details: unknown;
}

/**
 * Result of validating a tool call and its result.
 */
export interface ToolCallValidationResult {
	/** Whether the tool call and result are valid */
	isValid: boolean;
	/** Validation warnings (non-blocking) */
	warnings: string[];
	/** Fatal validation errors (blocking) */
	errors: string[];
}

/**
 * Expected result shape for known tools.
 */
const TOOL_RESULT_EXPECTATIONS: Record<
	string,
	{
		/** Fields expected in details */
		detailFields?: string[];
		/** Whether empty text content is suspicious for a success result */
		expectContent?: boolean;
		/** Whether the result should include a path or file reference */
		expectPath?: boolean;
	}
> = {
	read: { expectContent: true, expectPath: true },
	bash: { expectContent: true },
	edit: { expectContent: true, expectPath: true },
	write: { expectContent: true, expectPath: true },
	grep: { expectContent: true },
	find: { expectContent: true },
	ls: { expectContent: true },
	restore_snapshot: { expectPath: true, detailFields: ["treeOID"] },
	checkpoint_changes: { expectPath: true, detailFields: ["since"] },
	scratchpad_save: { expectPath: true, detailFields: ["path", "category"] },
	scratchpad_load: { expectContent: true },
};

/**
 * Validate a tool call and its result for basic sanity checks.
 *
 * Performs tier-1 validation only:
 * - Well-formedness: Does the result have expected structure?
 * - Sanity checks: Is empty content suspicious? Are expected fields present?
 * - Size validation: Is the result within reasonable bounds?
 *
 * This is called after tool execution to detect silent failures.
 */
export function validateToolCallResult(
	toolName: string,
	args: unknown,
	result: ToolResultForModel,
	isError: boolean,
): ToolCallValidationResult {
	const warnings: string[] = [];
	const errors: string[] = [];

	// Error results are validated differently - check for error message presence
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n")
			.trim();

		if (!errorText) {
			errors.push(`Tool ${toolName} returned an error but no error message`);
		}
		return { isValid: errors.length === 0, warnings, errors };
	}

	// Get expectations for this tool
	const expectations = TOOL_RESULT_EXPECTATIONS[toolName];

	// Extract text content
	const textContent = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
		.trim();

	// Check if success result has content when expected
	if (expectations?.expectContent && !textContent) {
		warnings.push(`Tool ${toolName} succeeded but returned no text content`);
	}

	// Check size sanity - warn if result is suspiciously large
	const contentSize = Buffer.byteLength(textContent, "utf-8");
	if (contentSize > 1024 * 1024) {
		warnings.push(`Tool ${toolName} result is unusually large (${formatSize(contentSize)})`);
	}

	// Check detail fields for known tools
	if (expectations?.detailFields && result.details && typeof result.details === "object") {
		const details = result.details as Record<string, unknown>;
		for (const field of expectations.detailFields) {
			if (details[field] === undefined) {
				warnings.push(`Tool ${toolName} result missing expected detail field: ${field}`);
			}
		}
	}

	// Check path-based tools have valid paths in args
	if (expectations?.expectPath) {
		const argsObj = args as Record<string, unknown> | undefined;
		const path = argsObj?.file_path ?? argsObj?.path ?? argsObj?.treeOID;
		if (!path || (typeof path === "string" && path.trim() === "")) {
			warnings.push(`Tool ${toolName} called without a valid path argument`);
		}
	}

	// Tool-specific validation
	if (toolName === "bash" || toolName === "shell") {
		const argsObj = args as Record<string, unknown> | undefined;
		const command = argsObj?.command;
		if (!command || (typeof command === "string" && command.trim() === "")) {
			warnings.push("Bash tool called without a command");
		}
	}

	if (toolName === "edit") {
		const argsObj = args as Record<string, unknown> | undefined;
		const oldStr = argsObj?.old_str ?? argsObj?.old;
		const newStr = argsObj?.new_str ?? argsObj?.new;
		if (!oldStr && !newStr) {
			warnings.push("Edit tool called without old_str/new_str arguments");
		}
	}

	return { isValid: errors.length === 0, warnings, errors };
}

/** Truncate content from the tail, keeping the last N bytes. */
function truncateTail(content: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(content, "utf-8") <= maxBytes) {
		return { text: content, truncated: false };
	}

	const bytes = Buffer.from(content, "utf-8");
	const truncatedBytes = bytes.slice(-maxBytes);
	// Skip any leading continuation bytes (0x10xxxxxx) from a partial
	// multi-byte sequence that was cut mid-character by the byte slice.
	let offset = 0;
	while (offset < truncatedBytes.length && (truncatedBytes[offset]! & 0xc0) === 0x80) {
		offset++;
	}
	const text = truncatedBytes.subarray(offset).toString("utf-8");

	return { text, truncated: true };
}

export function formatToolResultForModel(
	toolName: string,
	args: unknown,
	result: ToolResultForModel,
	isError: boolean,
	contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): (TextContent | ImageContent)[] | undefined {
	if (isError) {
		return undefined;
	}
	const toolResultBytes = proportionalToolOutputBytes(contextWindow);
	// Untyped extension tools (and hand-built tool results) may omit `content`.
	// Normalize to an empty array so the null never reaches rendering or the
	// provider payload (issues #6259, #6276).
	const content = result.content ?? [];
	const text = content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n")
		.trim();
	if (text.length === 0) {
		return undefined;
	}

	if (toolName === "read") {
		return undefined;
	}

	if (toolName === "bash" || toolName === "shell") {
		if (text.startsWith("[bash]")) {
			return undefined;
		}
		const command = getStringArg(args, "command");
		const header = command ? `[bash] $ ${command}` : "[bash]";
		const { text: truncatedText, truncated } = truncateTail(text, toolResultBytes);
		const finalText = truncated
			? `${header}\n... [truncated, showing last ${formatSize(toolResultBytes)}]\n${truncatedText}`
			: `${header}\n${truncatedText}`;
		return [{ type: "text", text: finalText }];
	}

	if (toolName === "edit") {
		if (text.startsWith("[edit]")) {
			return undefined;
		}
		const path = getStringArg(args, "file_path") ?? getStringArg(args, "path");
		const header = path ? `[edit] ${path}` : "[edit]";
		const { text: truncatedText, truncated } = truncateTail(text, toolResultBytes);
		const finalText = truncated
			? `${header}\n... [truncated, showing last ${formatSize(toolResultBytes)}]\n${truncatedText}`
			: `${header}\n${truncatedText}`;
		return [{ type: "text", text: finalText }];
	}

	if (toolName === "write") {
		if (text.startsWith("[write]")) {
			return undefined;
		}
		const path = getStringArg(args, "file_path") ?? getStringArg(args, "path");
		const header = path ? `[write] ${path}` : "[write]";
		const { text: truncatedText, truncated } = truncateTail(text, toolResultBytes);
		const finalText = truncated
			? `${header}\n... [truncated, showing last ${formatSize(toolResultBytes)}]\n${truncatedText}`
			: `${header}\n${truncatedText}`;
		return [{ type: "text", text: finalText }];
	}

	if (toolName === "grep") {
		if (text.startsWith("[grep]")) {
			return undefined;
		}
		const query = getStringArg(args, "pattern") ?? getStringArg(args, "query");
		const header = query ? `[grep] ${query}` : "[grep]";
		const { text: truncatedText, truncated } = truncateTail(text, toolResultBytes);
		const finalText = truncated
			? `${header}\n... [truncated, showing last ${formatSize(toolResultBytes)}]\n${truncatedText}`
			: `${header}\n${truncatedText}`;
		return [{ type: "text", text: finalText }];
	}

	if (toolName === "find") {
		if (text.startsWith("[find]")) {
			return undefined;
		}
		const pattern = getStringArg(args, "pattern") ?? getStringArg(args, "glob");
		const header = pattern ? `[find] ${pattern}` : "[find]";
		const { text: truncatedText, truncated } = truncateTail(text, toolResultBytes);
		const finalText = truncated
			? `${header}\n... [truncated, showing last ${formatSize(toolResultBytes)}]\n${truncatedText}`
			: `${header}\n${truncatedText}`;
		return [{ type: "text", text: finalText }];
	}

	if (toolName === "ls") {
		if (text.startsWith("[ls]")) {
			return undefined;
		}
		const dir = getStringArg(args, "path") ?? getStringArg(args, "directory");
		const header = dir ? `[ls] ${dir}` : "[ls]";
		const { text: truncatedText, truncated } = truncateTail(text, toolResultBytes);
		const finalText = truncated
			? `${header}\n... [truncated, showing last ${formatSize(toolResultBytes)}]\n${truncatedText}`
			: `${header}\n${truncatedText}`;
		return [{ type: "text", text: finalText }];
	}

	return undefined;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

function getStringArg(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== "object") {
		return undefined;
	}
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}
