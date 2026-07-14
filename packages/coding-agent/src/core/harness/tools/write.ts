import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTool } from "@piki/agent-core";
import { expandScratchpadPath } from "@piki/scratchpad";
import { Effect, Schema } from "effect";
import { Type } from "typebox";
import { harnessToolToAgentTool } from "../adapter.ts";
import { ToolErrorSchema } from "../tool-error.ts";
import type { HarnessTool } from "../types.ts";
import { defineHarnessTool } from "../types.ts";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Input schema (Effect Schema)
// ---------------------------------------------------------------------------

export const WriteInputSchema = Schema.Struct({
	path: Schema.String.pipe(
		Schema.annotations({
			description: "Relative path from cwd. Use $M/ prefix for scratchpad path.",
		}),
	),
	content: Schema.String.pipe(
		Schema.annotations({
			description: "File content to write",
		}),
	),
});

export type WriteInput = Schema.Schema.Type<typeof WriteInputSchema>;

// ---------------------------------------------------------------------------
// Output schema — Schema.Void
// ---------------------------------------------------------------------------

export const WriteOutputSchema = Schema.Void;

// ---------------------------------------------------------------------------
// Error schema — FsError (same as read tool)
// ---------------------------------------------------------------------------

export const FsErrorSchema = ToolErrorSchema("FsError", {});

export type FsError = Schema.Schema.Type<typeof FsErrorSchema>;

/** Construct an FsError value. */
function fsError(message: string): FsError {
	return { _tag: "FsError", message };
}

// ---------------------------------------------------------------------------
// Emission schema — write_stats
// ---------------------------------------------------------------------------

export const WriteEmissionSchema = Schema.Struct({
	type: Schema.Literal("write_stats"),
	path: Schema.String,
	linesWritten: Schema.Number,
});

// ---------------------------------------------------------------------------
// TypeBox parameters (for AgentTool / ToolDefinition compatibility)
// ---------------------------------------------------------------------------

export const writeParameters = Type.Object({
	path: Type.String({
		description: "Relative path from cwd. Use $M/ prefix for scratchpad path.",
	}),
	content: Type.String({
		description: "File content to write",
	}),
});

// ---------------------------------------------------------------------------
// defineWriteHarnessTool — the 1:1 execution core
// ---------------------------------------------------------------------------

/**
 * Define the write tool as a HarnessTool.
 *
 * DEVIATION NOTE: Same as read.ts — the piki harness does not provision Effect
 * services (WorkingDirectoryTag, Fs). We closure-inject `cwd` and
 * `scratchpadPath` and use `fs.promises.writeFile` directly.
 *
 * emissionSchema is set on the HarnessTool for structural inspection. The actual
 * emission is fired via the adapter's onEmission callback (see createWriteAgentTool).
 */
export function defineWriteHarnessTool(cwd: string, scratchpadPath: string): HarnessTool<WriteInput, void, FsError> {
	return defineHarnessTool<WriteInput, void, FsError>({
		definition: {
			name: "write",
			description:
				"Write content to file, completely replacing any existing content. Read file in full if already exists before overwriting. Use this instead of running echo, tee, or heredocs in the shell. For partial edits, use the edit tool instead.",
			inputSchema: WriteInputSchema,
			outputSchema: WriteOutputSchema,
		},
		execute: (input: WriteInput): Effect.Effect<void, FsError> =>
			Effect.gen(function* () {
				// 1. Expand scratchpad path ($M/ prefix)
				const expandedPath = expandScratchpadPath(input.path, scratchpadPath).path;

				// 2. Resolve to absolute path
				const fullPath = resolve(cwd, expandedPath);

				// 3. Write file — on failure, fail with FsError
				yield* Effect.tryPromise({
					try: () => writeFile(fullPath, input.content, "utf-8"),
					catch: () => fsError(`Failed to write ${input.path}`),
				});
			}),
		emissionSchema: WriteEmissionSchema,
		errorSchema: FsErrorSchema,
	});
}

// ---------------------------------------------------------------------------
// createWriteAgentTool — adapter conversion
// ---------------------------------------------------------------------------

/**
 * Convert the write HarnessTool into an AgentTool via the adapter.
 *
 * The emission ({type:"write_stats", path, linesWritten}) is fired through
 * the adapter's onEmission callback after successful execution.
 */
export function createWriteAgentTool(
	harnessTool: HarnessTool<WriteInput, void, FsError>,
): AgentTool<typeof writeParameters, void> {
	return harnessToolToAgentTool(harnessTool, {
		parameters: writeParameters,
		label: "write",
		mapInput: (args) => args as WriteInput,
		onEmission: (_output, onUpdate, input) => {
			onUpdate?.({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							type: "write_stats",
							path: input.path,
							linesWritten: input.content.split("\n").length,
						}),
					},
				],
				details: undefined,
			});
		},
	});
}
