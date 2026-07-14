import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
// ---------------------------------------------------------------------------
// Input schema (Effect Schema)
// ---------------------------------------------------------------------------

export const ReadInputSchema = Schema.Struct({
	path: Schema.String.pipe(
		Schema.annotations({
			description:
				"Relative path to a file from cwd. Use $M/ prefix for scratchpad path. Use tree instead for directories",
		}),
	),
	offset: Schema.optionalWith(Schema.Number.annotations({ description: "1-indexed start line (default: 1)" }), {
		exact: true,
	}),
	limit: Schema.optionalWith(Schema.Number.annotations({ description: "Max lines to return (default: 2000)" }), {
		exact: true,
	}),
});

export type ReadInput = Schema.Schema.Type<typeof ReadInputSchema>;

// ---------------------------------------------------------------------------
// Output schema — plain String
// ---------------------------------------------------------------------------

export const ReadOutputSchema = Schema.String;

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
// TypeBox parameters (for AgentTool / ToolDefinition compatibility)
// ---------------------------------------------------------------------------

export const readParameters = Type.Object({
	path: Type.String({
		description:
			"Relative path to a file from cwd. Use $M/ prefix for scratchpad path. Use tree instead for directories",
	}),
	offset: Type.Optional(Type.Number({ description: "1-indexed start line (default: 1)" })),
	limit: Type.Optional(Type.Number({ description: "Max lines to return (default: 2000)" })),
});

// ---------------------------------------------------------------------------
// defineReadHarnessTool — the 1:1 execution core
// ---------------------------------------------------------------------------

/**
 * Define the read tool as a HarnessTool.
 *
 * DEVIATION NOTE: The piki harness does not provide Effect services for
 * working directory or filesystem access. We closure-inject `cwd` and
 * `scratchpadPath` and use `fs.promises.readFile` directly instead of
 * yielding service tags. Effect services can be introduced later when
 * multiple tools share them.
 */
export function defineReadHarnessTool(cwd: string, scratchpadPath: string): HarnessTool<ReadInput, string, FsError> {
	return defineHarnessTool<ReadInput, string, FsError>({
		definition: {
			name: "read",
			description:
				"Read file text content. Use this instead of running cat, head, tail, or less in the shell. Large files are automatically truncated. Read the full file when reading for understanding or editing. Only use offset/limit for partial reads when tracing specific symbols or locating related files. Do not re-read files that are already in your context window.",
			inputSchema: ReadInputSchema,
			outputSchema: ReadOutputSchema,
		},
		execute: (input: ReadInput): Effect.Effect<string, FsError> =>
			Effect.gen(function* () {
				// 1. Expand scratchpad path ($M/ prefix)
				const expandedPath = expandScratchpadPath(input.path, scratchpadPath).path;

				// 2. Resolve to absolute path
				const fullPath = resolve(cwd, expandedPath);

				// 3. Read text — on failure, fail with FsError
				const content = yield* Effect.tryPromise({
					try: () => readFile(fullPath, "utf-8"),
					catch: () => fsError(`Failed to read ${input.path}`),
				});

				// 4. Split into lines
				const lines = content.split("\n");

				// 5. Defaults
				const startLine = input.offset ?? 1;
				const maxLines = input.limit ?? 2000;

				// 6. Validate
				if (startLine < 1) {
					return yield* Effect.fail(fsError("offset must be >= 1"));
				}
				if (startLine > lines.length) {
					return yield* Effect.fail(fsError(`offset ${startLine} exceeds total lines ${lines.length}`));
				}

				// 7. Slice
				const startIdx = startLine - 1;
				const endIdx = startIdx + maxLines;
				const slice = lines.slice(startIdx, endIdx);

				// 8. Suffix (standard format)
				const remaining = lines.length - endIdx;
				let result = slice.join("\n");
				if (remaining > 0) {
					result +=
						"\n... (" +
						remaining +
						" more lines remaining. Use offset=" +
						(startLine + maxLines) +
						" to continue reading.)";
				}

				// 9. Return plain string
				return result;
			}),
		stream: {
			// Synchronous validation — matches HarnessToolStream type signature (=> void).
			// Throws StreamValidationError if the file doesn't exist when path is provided.
			onInput: (input: Partial<ReadInput>): void => {
				if (typeof input.path !== "string" || input.path.length === 0) return;
				const expandedPath = expandScratchpadPath(input.path, scratchpadPath).path;
				const fullPath = resolve(cwd, expandedPath);
				if (!existsSync(fullPath)) {
					throw new StreamValidationError({ message: `File not found: ${input.path}` });
				}
			},
		},
		errorSchema: FsErrorSchema,
	});
}

// ---------------------------------------------------------------------------
// createReadAgentTool — adapter conversion
// ---------------------------------------------------------------------------

/**
 * Convert the read HarnessTool into an AgentTool via the adapter.
 * Since outputSchema is Schema.String, the default `formatHarnessOutput`
 * handles string output (returns it as-is). No image support needed.
 */
export function createReadAgentTool(
	harnessTool: HarnessTool<ReadInput, string, FsError>,
): AgentTool<typeof readParameters, string> {
	return harnessToolToAgentTool(harnessTool, {
		parameters: readParameters,
		label: "read",
		mapInput: (args) => args as ReadInput,
	});
}
