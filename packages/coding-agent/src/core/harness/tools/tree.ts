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

export const TreeInputSchema = Schema.Struct({
	path: Schema.String.pipe(
		Schema.annotations({
			description: "Relative path from cwd. Use $M/ prefix for scratchpad path.",
		}),
	),
	recursive: Schema.optionalWith(
		Schema.Boolean.annotations({ description: "Include subdirectories (default: true)" }),
		{ exact: true },
	),
	maxDepth: Schema.optionalWith(Schema.Number.annotations({ description: "Maximum depth to traverse" }), {
		exact: true,
	}),
	gitignore: Schema.optionalWith(
		Schema.Boolean.annotations({ description: "Respect .gitignore patterns (default: true)" }),
		{ exact: true },
	),
});

export type TreeInput = Schema.Schema.Type<typeof TreeInputSchema>;

// ---------------------------------------------------------------------------
// Output schema — Array of TreeEntry
// ---------------------------------------------------------------------------

export const TreeEntrySchema = Schema.Struct({
	path: Schema.String,
	name: Schema.String,
	type: Schema.Literal("file", "dir"),
	depth: Schema.Number,
});

export type TreeEntry = Schema.Schema.Type<typeof TreeEntrySchema>;

export const TreeOutputSchema = Schema.Array(TreeEntrySchema);

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

export const treeParameters = Type.Object({
	path: Type.String({
		description: "Relative path from cwd. Use $M/ prefix for scratchpad path.",
	}),
	recursive: Type.Optional(Type.Boolean({ description: "Include subdirectories (default: true)" })),
	maxDepth: Type.Optional(Type.Number({ description: "Maximum depth to traverse" })),
	gitignore: Type.Optional(Type.Boolean({ description: "Respect .gitignore patterns (default: true)" })),
});

// ---------------------------------------------------------------------------
// Gitignore matching (basic implementation)
// ---------------------------------------------------------------------------

/**
 * Simple .gitignore pattern matcher.
 * Supports: exact names, glob patterns with *, and directory-only patterns (trailing /).
 * Reads .gitignore files from ancestor directories.
 */
function loadGitignorePatterns(rootDir: string): string[] {
	const patterns: string[] = [];
	// Walk up from rootDir collecting .gitignore patterns
	let dir = rootDir;
	const dirs: string[] = [];
	// Collect up to filesystem root — but limit to reasonable depth
	for (let i = 0; i < 20; i++) {
		dirs.push(dir);
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	// Process from root down (root patterns have higher priority)
	for (let i = dirs.length - 1; i >= 0; i--) {
		const giPath = join(dirs[i], ".gitignore");
		if (existsSync(giPath)) {
			try {
				const content = readFileSync(giPath, "utf-8");
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (trimmed && !trimmed.startsWith("#")) {
						patterns.push(trimmed);
					}
				}
			} catch {
				// ignore read errors
			}
		}
	}
	return patterns;
}

function matchesGitignore(name: string, relativePath: string, isDir: boolean, patterns: string[]): boolean {
	for (const pattern of patterns) {
		// Negation patterns — if a pattern starts with ! it means "do not ignore"
		// For basic implementation we skip negation support
		if (pattern.startsWith("!")) continue;

		// Directory-only pattern (trailing /)
		let p = pattern;
		const dirOnly = p.endsWith("/");
		if (dirOnly) {
			p = p.slice(0, -1);
			if (!isDir) continue;
		}

		// Exact name match
		if (p === name || p === relativePath) return true;

		// Glob with *
		if (p.includes("*")) {
			const regex = globToRegex(p);
			if (regex.test(name) || regex.test(relativePath)) return true;
		}

		// Path prefix match (e.g. "node_modules" matches "node_modules/foo")
		if (relativePath === p || relativePath.startsWith(`${p}/`)) return true;
	}
	return false;
}

function globToRegex(pattern: string): RegExp {
	// Convert glob to regex: * → .*, ? → .
	let regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	regexStr = regexStr.replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${regexStr}$`);
}

// ---------------------------------------------------------------------------
// Directory walk
// ---------------------------------------------------------------------------

interface WalkOptions {
	recursive: boolean;
	maxDepth: number;
	gitignore: boolean;
	rootDir: string;
}

function walkDir(
	dirAbsPath: string,
	dirRelPath: string,
	depth: number,
	opts: WalkOptions,
	patterns: string[],
	entries: TreeEntry[],
): void {
	let names: string[];
	try {
		names = readdirSync(dirAbsPath);
	} catch {
		return;
	}

	for (const name of names) {
		// Always skip .git directory
		if (name === ".git") continue;

		const entryAbsPath = join(dirAbsPath, name);
		const entryRelPath = dirRelPath === "" ? name : `${dirRelPath}/${name}`;

		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(entryAbsPath);
		} catch {
			continue;
		}

		const isDir = stat.isDirectory();
		const isFile = stat.isFile();

		// Gitignore check
		if (opts.gitignore && matchesGitignore(name, entryRelPath, isDir, patterns)) {
			continue;
		}

		if (isFile) {
			entries.push({
				path: entryRelPath,
				name,
				type: "file" as const,
				depth,
			});
		} else if (isDir) {
			entries.push({
				path: entryRelPath,
				name,
				type: "dir" as const,
				depth,
			});
			if (opts.recursive && depth < opts.maxDepth) {
				walkDir(entryAbsPath, entryRelPath, depth + 1, opts, patterns, entries);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// defineTreeHarnessTool — the 1:1 execution core
// ---------------------------------------------------------------------------

export function defineTreeHarnessTool(
	cwd: string,
	scratchpadPath: string,
): HarnessTool<TreeInput, readonly TreeEntry[], FsError> {
	return defineHarnessTool<TreeInput, readonly TreeEntry[], FsError>({
		definition: {
			name: "tree",
			description:
				"List directory structure with optional gitignore filtering. Use this instead of running ls, find, or tree in the shell.",
			inputSchema: TreeInputSchema,
			outputSchema: TreeOutputSchema,
		},
		execute: (input: TreeInput): Effect.Effect<readonly TreeEntry[], FsError> =>
			Effect.gen(function* () {
				const recursive = input.recursive ?? true;
				const maxDepth = input.maxDepth ?? 10;
				const useGitignore = input.gitignore ?? true;

				// 1. Expand scratchpad path
				const expandedPath = expandScratchpadPath(input.path, scratchpadPath).path;

				// 2. Resolve to absolute path
				const fullPath = resolve(cwd, expandedPath);

				// 3. Walk directory — on failure, fail with FsError
				const entries: TreeEntry[] = [];
				try {
					const patterns = useGitignore ? loadGitignorePatterns(fullPath) : [];
					// Use "" as the relative root for clean paths
					walkDir(
						fullPath,
						"",
						0,
						{ recursive, maxDepth, gitignore: useGitignore, rootDir: fullPath },
						patterns,
						entries,
					);
				} catch {
					return yield* Effect.fail(fsError(`Failed to list ${input.path}`));
				}

				return entries;
			}),
		stream: {
			onInput: (input: Partial<TreeInput>): void => {
				if (typeof input.path !== "string" || input.path.length === 0) return;
				const expandedPath = expandScratchpadPath(input.path, scratchpadPath).path;
				const fullPath = resolve(cwd, expandedPath);
				if (!existsSync(fullPath)) {
					throw new StreamValidationError({ message: `Path not found: ${input.path}` });
				}
			},
		},
		errorSchema: FsErrorSchema,
	});
}

// ---------------------------------------------------------------------------
// createTreeAgentTool — adapter conversion
// ---------------------------------------------------------------------------

export function createTreeAgentTool(
	harnessTool: HarnessTool<TreeInput, readonly TreeEntry[], FsError>,
): AgentTool<typeof treeParameters, readonly TreeEntry[]> {
	return harnessToolToAgentTool(harnessTool, {
		parameters: treeParameters,
		label: "tree",
		mapInput: (args) => args as TreeInput,
	});
}
