import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

export const GrepInputSchema = Schema.Struct({
	pattern: Schema.String.pipe(
		Schema.annotations({
			description: "Regex pattern to search for",
		}),
	),
	path: Schema.optionalWith(
		Schema.String.annotations({
			description: "Directory to search in (default: cwd). Use $M/ prefix for scratchpad path.",
		}),
		{ exact: true },
	),
	glob: Schema.optionalWith(
		Schema.String.annotations({
			description: 'Glob pattern to filter files (e.g., "*.ts")',
		}),
		{ exact: true },
	),
	limit: Schema.optionalWith(
		Schema.Number.annotations({ description: "Maximum number of matches to return (default: 50)" }),
		{ exact: true },
	),
});

export type GrepInput = Schema.Schema.Type<typeof GrepInputSchema>;

// ---------------------------------------------------------------------------
// Output schema — Array of SearchMatch
// ---------------------------------------------------------------------------

export const SearchMatchSchema = Schema.Struct({
	file: Schema.String,
	match: Schema.String,
});

export type SearchMatch = Schema.Schema.Type<typeof SearchMatchSchema>;

export const GrepOutputSchema = Schema.Array(SearchMatchSchema);

// ---------------------------------------------------------------------------
// Error schema — FsError
// ---------------------------------------------------------------------------

export const FsErrorSchema = ToolErrorSchema("FsError", {});

export type FsError = Schema.Schema.Type<typeof FsErrorSchema>;

function fsError(message: string): FsError {
	return { _tag: "FsError", message };
}

// ---------------------------------------------------------------------------
// TypeBox parameters (for AgentTool / ToolDefinition compatibility)
// ---------------------------------------------------------------------------

export const grepParameters = Type.Object({
	pattern: Type.String({ description: "Regex pattern to search for" }),
	path: Type.Optional(
		Type.String({
			description: "Directory to search in (default: cwd). Use $M/ prefix for scratchpad path.",
		}),
	),
	glob: Type.Optional(Type.String({ description: 'Glob pattern to filter files (e.g., "*.ts")' })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 50)" })),
});

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
	let regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	regexStr = regexStr.replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${regexStr}$`);
}

// ---------------------------------------------------------------------------
// Recursive file search
// ---------------------------------------------------------------------------

function searchFiles(
	dirAbsPath: string,
	dirRelPath: string,
	regex: RegExp,
	globRegex: RegExp | null,
	limit: number,
	matches: SearchMatch[],
): void {
	if (matches.length >= limit) return;

	let names: string[];
	try {
		names = readdirSync(dirAbsPath);
	} catch {
		return;
	}

	for (const name of names) {
		if (matches.length >= limit) return;

		// Skip .git directory
		if (name === ".git") continue;

		const entryAbsPath = join(dirAbsPath, name);
		const entryRelPath = dirRelPath === "" ? name : `${dirRelPath}/${name}`;

		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(entryAbsPath);
		} catch {
			continue;
		}

		if (stat.isDirectory()) {
			searchFiles(entryAbsPath, entryRelPath, regex, globRegex, limit, matches);
		} else if (stat.isFile()) {
			// Apply glob filter
			if (globRegex && !globRegex.test(name)) continue;

			let content: string;
			try {
				content = readFileSync(entryAbsPath, "utf-8");
			} catch {
				continue;
			}

			for (const line of content.split("\n")) {
				if (matches.length >= limit) return;
				if (regex.test(line)) {
					matches.push({
						file: entryRelPath,
						match: line,
					});
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// defineGrepHarnessTool — the 1:1 execution core
// ---------------------------------------------------------------------------

export function defineGrepHarnessTool(
	cwd: string,
	scratchpadPath: string,
): HarnessTool<GrepInput, readonly SearchMatch[], FsError> {
	return defineHarnessTool<GrepInput, readonly SearchMatch[], FsError>({
		definition: {
			name: "grep",
			description:
				"Search file contents with regex. Use this instead of running grep, rg, or ag in the shell — it uses ripgrep under the hood.",
			inputSchema: GrepInputSchema,
			outputSchema: GrepOutputSchema,
		},
		execute: (input: GrepInput): Effect.Effect<readonly SearchMatch[], FsError> =>
			Effect.gen(function* () {
				const limit = input.limit ?? 50;
				let regex: RegExp;
				try {
					regex = new RegExp(input.pattern);
				} catch {
					return yield* Effect.fail(fsError(`Search failed for ${input.pattern}`));
				}

				// 1. Expand scratchpad path — default to cwd
				const inputPath = input.path ?? "";
				const expanded = expandScratchpadPath(inputPath, scratchpadPath);
				const searchPath = expanded.path && expanded.path !== "" ? resolve(cwd, expanded.path) : cwd;

				// 2. Glob filter
				const globRegex = input.glob ? globToRegex(input.glob) : null;

				// 3. Search — on failure, fail with FsError
				const matches: SearchMatch[] = [];
				try {
					searchFiles(searchPath, "", regex, globRegex, limit, matches);
				} catch {
					return yield* Effect.fail(fsError(`Search failed for ${input.pattern}`));
				}

				return matches;
			}),
		stream: {
			onInput: (input: Partial<GrepInput>): void => {
				if (typeof input.path !== "string" || input.path.length === 0) return;
				const expanded = expandScratchpadPath(input.path, scratchpadPath);
				const fullPath = expanded.path && expanded.path !== "" ? resolve(cwd, expanded.path) : cwd;
				if (!existsSync(fullPath)) {
					throw new StreamValidationError({ message: `Path not found: ${input.path}` });
				}
			},
		},
		errorSchema: FsErrorSchema,
	});
}

// ---------------------------------------------------------------------------
// createGrepAgentTool — adapter conversion
// ---------------------------------------------------------------------------

export function createGrepAgentTool(
	harnessTool: HarnessTool<GrepInput, readonly SearchMatch[], FsError>,
): AgentTool<typeof grepParameters, readonly SearchMatch[]> {
	return harnessToolToAgentTool(harnessTool, {
		parameters: grepParameters,
		label: "grep",
		mapInput: (args) => args as GrepInput,
	});
}
