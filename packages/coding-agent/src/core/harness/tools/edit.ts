import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTool } from "@piki/agent-core";
import { expandScratchpadPath } from "@piki/scratchpad";
import { Effect, Schema } from "effect";
import { Type } from "typebox";
import { harnessToolToAgentTool } from "../adapter.ts";
import { StreamValidationError } from "../stream-validation.ts";
import { ToolErrorSchema } from "../tool-error.ts";
import type { HarnessTool } from "../types.ts";
import { defineHarnessTool } from "../types.ts";

// ---------------------------------------------------------------------------
// Input schema (Effect Schema)
// ---------------------------------------------------------------------------

export const EditInputSchema = Schema.Struct({
	path: Schema.String.pipe(
		Schema.annotations({
			description: "Relative path from cwd. Use $M/ prefix for scratchpad path.",
		}),
	),
	old: Schema.String.pipe(
		Schema.annotations({
			description: "Exact text to find in the file",
		}),
	),
	new: Schema.String.pipe(
		Schema.annotations({
			description: "Replacement text",
		}),
	),
	replaceAll: Schema.optionalWith(
		Schema.Boolean.annotations({
			description: "Replace all occurrences instead of requiring uniqueness",
		}),
		{ exact: true },
	),
});

export type EditInput = Schema.Schema.Type<typeof EditInputSchema>;

// ---------------------------------------------------------------------------
// Output schema — Schema.String (summary message)
// ---------------------------------------------------------------------------

export const EditOutputSchema = Schema.String;

// ---------------------------------------------------------------------------
// Error schema — FsError
// ---------------------------------------------------------------------------

export const FsErrorSchema = ToolErrorSchema("FsError", {});

export type FsError = Schema.Schema.Type<typeof FsErrorSchema>;

/** Construct an FsError value. */
function fsError(message: string): FsError {
	return { _tag: "FsError", message };
}

// ---------------------------------------------------------------------------
// Emission schema — file_edit_base_content
// ---------------------------------------------------------------------------

export const EditEmissionSchema = Schema.Struct({
	type: Schema.Literal("file_edit_base_content"),
	path: Schema.String,
	baseContent: Schema.String,
});

// ---------------------------------------------------------------------------
// TypeBox parameters (for AgentTool / ToolDefinition compatibility)
// ---------------------------------------------------------------------------

export const editParameters = Type.Object({
	path: Type.String({
		description: "Relative path from cwd. Use $M/ prefix for scratchpad path.",
	}),
	old: Type.String({
		description: "Exact text to find in the file",
	}),
	new: Type.String({
		description: "Replacement text",
	}),
	replaceAll: Type.Optional(
		Type.Boolean({
			description: "Replace all occurrences instead of requiring uniqueness",
		}),
	),
});

// ---------------------------------------------------------------------------
// validateAndApply
// ---------------------------------------------------------------------------

/** Count non-overlapping occurrences of a substring in a string. */
function countOccurrences(content: string, sub: string): number {
	if (sub.length === 0) return 0;
	let count = 0;
	let idx = 0;
	while (idx < content.length) {
		const nextIdx = content.indexOf(sub, idx);
		if (nextIdx === -1) break;
		count++;
		idx = nextIdx + sub.length;
	}
	return count;
}

/** Get the 1-indexed line number at a given character index. */
function lineNumberAt(content: string, charIndex: number): number {
	let line = 1;
	for (let i = 0; i < charIndex && i < content.length; i++) {
		if (content[i] === "\n") line++;
	}
	return line;
}

export interface ValidateAndApplyResult {
	result: string;
	startLine: number;
	removedLines: string[];
	addedLines: string[];
	replaceCount: number;
}

/**
 * Validate the edit parameters and apply them to the content.
 *
 * DEVIATION NOTE: tryVirtualMatch (edge-case for leading/trailing
 * newline matching) is not ported. Documented as structural deviation.
 */
export function validateAndApply(
	content: string,
	oldStr: string,
	newStr: string,
	replaceAll: boolean,
): ValidateAndApplyResult {
	if (oldStr.length === 0) {
		throw new Error('"old" parameter content must not be empty.');
	}

	const occurrences = countOccurrences(content, oldStr);

	if (occurrences === 0) {
		throw new Error('"old" parameter content not found in file. Ensure it matches the file exactly.');
	}

	if (!replaceAll && occurrences > 1) {
		throw new Error(
			`"old" parameter content matches ${occurrences} locations. Use replaceAll: true to replace all, or make the "old" parameter more specific.`,
		);
	}

	const removedLines = oldStr.split("\n");
	const addedLines = newStr.split("\n");

	const firstIdx = content.indexOf(oldStr);
	const startLine = lineNumberAt(content, firstIdx);

	let result: string;
	let replaceCount: number;

	if (replaceAll) {
		result = content.split(oldStr).join(newStr);
		replaceCount = occurrences;
	} else {
		result = content.slice(0, firstIdx) + newStr + content.slice(firstIdx + oldStr.length);
		replaceCount = 1;
	}

	return { result, startLine, removedLines, addedLines, replaceCount };
}

// ---------------------------------------------------------------------------
// defineEditHarnessTool — the 1:1 execution core
// ---------------------------------------------------------------------------

/**
 * Define the edit tool as a HarnessTool.
 *
 * DEVIATION NOTE: Same as read.ts — closure-inject cwd/scratchpadPath instead
 * of Effect services. Uses fs.promises directly.
 *
 * STREAM DEVIATION: The edit tool has a two-phase stream validation
 * (emit baseContent, then validate on completion). Piki's HarnessToolStream.onInput
 * is synchronous (=> void), so we only do a path-existence check synchronously.
 * The two-phase Effect-based stream is not replicated.
 */
export function defineEditHarnessTool(cwd: string, scratchpadPath: string): HarnessTool<EditInput, string, FsError> {
	return defineHarnessTool<EditInput, string, FsError>({
		definition: {
			name: "edit",
			description:
				'Edit a file by replacing exact text. The "old" parameter content must match the file exactly. Read the file first. Use this instead of running sed, perl, or awk in the shell. If an edit touches >50% of file content, write is more efficient.',
			inputSchema: EditInputSchema,
			outputSchema: EditOutputSchema,
		},
		execute: (input: EditInput): Effect.Effect<string, FsError> =>
			Effect.gen(function* () {
				// 1. Expand scratchpad path ($M/ prefix)
				const expandedPath = expandScratchpadPath(input.path, scratchpadPath).path;

				// 2. Resolve to absolute path
				const fullPath = resolve(cwd, expandedPath);

				// 3. Read file content
				const content = yield* Effect.tryPromise({
					try: () => readFile(fullPath, "utf-8"),
					catch: () => fsError(`Failed to read ${input.path}`),
				});

				// 4. Validate and apply edit
				let applied: ValidateAndApplyResult;
				try {
					applied = validateAndApply(content, input.old, input.new, input.replaceAll ?? false);
				} catch (e) {
					return yield* Effect.fail(fsError((e as Error).message));
				}

				// 5. Write result
				yield* Effect.tryPromise({
					try: () => writeFile(fullPath, applied.result, "utf-8"),
					catch: () => fsError(`Failed to write ${input.path}`),
				});

				// 6. Build output message (standard format)
				const { replaceCount, removedLines, addedLines } = applied;

				if (replaceCount > 1) {
					return `Replaced ${replaceCount} occurrences in ${input.path}`;
				}
				if (input.new.length === 0) {
					return `Deleted ${removedLines.length} line(s) from ${input.path}`;
				}
				return `Replaced ${removedLines.length} line(s) with ${addedLines.length} line(s) in ${input.path}`;
			}),
		stream: {
			// Synchronous validation — matches HarnessToolStream type signature (=> void).
			// Throws StreamValidationError if the file doesn't exist.
			// DEVIATION: The two-phase Effect-based stream (emit baseContent +
			// validate on completion) is not replicated — only path-existence check.
			onInput: (input: Partial<EditInput>): void => {
				if (typeof input.path !== "string" || input.path.length === 0) return;
				const expandedPath = expandScratchpadPath(input.path, scratchpadPath).path;
				const fullPath = resolve(cwd, expandedPath);
				if (!existsSync(fullPath)) {
					throw new StreamValidationError({ message: `File not found: ${input.path}` });
				}
			},
		},
		emissionSchema: EditEmissionSchema,
		errorSchema: FsErrorSchema,
	});
}

// ---------------------------------------------------------------------------
// createEditAgentTool — adapter conversion
// ---------------------------------------------------------------------------

/**
 * Convert the edit HarnessTool into an AgentTool via the adapter.
 * Output is a summary string, handled by formatHarnessOutput as-is.
 */
export function createEditAgentTool(
	harnessTool: HarnessTool<EditInput, string, FsError>,
): AgentTool<typeof editParameters, string> {
	return harnessToolToAgentTool(harnessTool, {
		parameters: editParameters,
		label: "edit",
		mapInput: (args) => args as EditInput,
	});
}
