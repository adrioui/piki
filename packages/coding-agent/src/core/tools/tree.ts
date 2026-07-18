import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@piki/agent-core";
import { Text } from "@piki/tui";
import nodePath from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { pathExists, resolveToolPath } from "./path-utils.ts";
import { getTextOutput, renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const treeSchema = Type.Object({
	path: Type.String({ description: "Relative path from cwd. Use $M/ prefix for scratchpad path." }),
	recursive: Type.Optional(Type.Boolean({ description: "Include subdirectories (default: true)" })),
	maxDepth: Type.Optional(Type.Number({ description: "Maximum depth to traverse" })),
	gitignore: Type.Optional(Type.Boolean({ description: "Respect .gitignore patterns (default: true)" })),
});

export type TreeToolInput = Static<typeof treeSchema>;

const DEFAULT_LIMIT = 500;

export interface TreeToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
	/** Structured mirror of mag's TreeEntry[]; primary model-visible output remains text. */
	entries?: Array<{ path: string; name: string; type: "file" | "dir"; depth: number }>;
}

interface TreeEntry {
	/** Relative path from the root directory */
	path: string;
	/** Entry name (basename) */
	name: string;
	/** "file" or "dir" */
	type: "file" | "dir";
	/** Depth from root (root entries are depth 1) */
	depth: number;
}

/**
 * Pluggable operations for the tree tool.
 * Override these to delegate directory traversal to remote systems (for example SSH).
 */
export interface TreeOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Get file or directory stats. Throws if not found. */
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	/** Read directory entries */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultTreeOperations: TreeOperations = {
	exists: pathExists,
	stat: fsStat,
	readdir: fsReaddir,
};

export interface TreeToolOptions {
	/** Custom operations for directory traversal. Default: local filesystem */
	operations?: TreeOperations;
	/** Scratchpad directory, used to resolve $M/ paths with Magnitude-alpha22 parity. */
	scratchpadPath?: string;
}

function formatTreeCall(
	args: { path?: string; recursive?: boolean; maxDepth?: number; gitignore?: boolean } | undefined,
	theme: Theme,
	cwd: string,
): string {
	const recursive = args?.recursive;
	const maxDepth = args?.maxDepth;
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: "." });
	let text = `${theme.fg("toolTitle", theme.bold("tree"))} ${pathDisplay}`;
	if (recursive) {
		text += theme.fg("toolOutput", " (recursive");
		if (maxDepth !== undefined) text += theme.fg("toolOutput", `, depth ${maxDepth}`);
		text += theme.fg("toolOutput", ")");
	}
	return text;
}

function formatTreeResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: TreeToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const entryLimit = result.details?.entryLimitReached;
	const truncation = result.details?.truncation;
	if (entryLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (entryLimit) warnings.push(`${entryLimit} entries limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createTreeToolDefinition(
	cwd: string,
	options?: TreeToolOptions,
): ToolDefinition<typeof treeSchema, TreeToolDetails | undefined> {
	const ops = options?.operations ?? defaultTreeOperations;
	const scratchpadPath = options?.scratchpadPath ?? "";
	return {
		name: "tree",
		label: "tree",
		description:
			"List directory structure with optional gitignore filtering. Use this instead of running ls, find, or tree in the shell.",
		parameters: treeSchema,
		async execute(
			_toolCallId,
			{
				path,
				recursive,
				maxDepth,
				gitignore,
			}: {
				path: string;
				recursive?: boolean;
				maxDepth?: number;
				gitignore?: boolean;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const dirPath = resolveToolPath(path || ".", cwd, scratchpadPath);
						const isRecursive = recursive ?? true;
						const effectiveMaxDepth = maxDepth ?? (isRecursive ? 10 : 1);
						const respectGitignore = gitignore ?? true;

						// Check if path exists.
						if (!(await ops.exists(dirPath))) {
							reject(new Error(`Path not found: ${dirPath}`));
							return;
						}

						// Check if path is a directory.
						const stat = await ops.stat(dirPath);
						if (!stat.isDirectory()) {
							reject(new Error(`Not a directory: ${dirPath}`));
							return;
						}

						const entries: TreeEntry[] = [];
						let entryLimitReached = false;

						// BFS traversal using a queue of { dirPath, relativePath, depth }
						const queue: Array<{ dir: string; rel: string; depth: number }> = [
							{ dir: dirPath, rel: "", depth: 0 },
						];

						while (queue.length > 0 && !entryLimitReached) {
							if (signal?.aborted) {
								reject(new Error("Operation aborted"));
								return;
							}

							const { dir, rel, depth } = queue.shift()!;

							// Don't traverse beyond maxDepth.
							if (depth >= effectiveMaxDepth) continue;

							let dirEntries: string[];
							try {
								dirEntries = await ops.readdir(dir);
							} catch {
								// Skip directories we cannot read.
								continue;
							}

							// Sort alphabetically, case-insensitive.
							dirEntries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

							for (const entry of dirEntries) {
								if (entries.length >= DEFAULT_LIMIT) {
									entryLimitReached = true;
									break;
								}

								if (signal?.aborted) {
									reject(new Error("Operation aborted"));
									return;
								}

								// Skip .git directory when gitignore is enabled.
								if (respectGitignore && entry === ".git") continue;

								const fullPath = nodePath.join(dir, entry);
								const relativePath = rel ? `${rel}/${entry}` : entry;

								let isDir = false;
								try {
									const entryStat = await ops.stat(fullPath);
									isDir = entryStat.isDirectory();
								} catch {
									// Skip entries we cannot stat.
									continue;
								}

								entries.push({
									path: relativePath,
									name: entry,
									type: isDir ? "dir" : "file",
									depth: depth + 1,
								});

								// If directory and recursive, queue for traversal.
								if (isDir && isRecursive) {
									queue.push({ dir: fullPath, rel: relativePath, depth: depth + 1 });
								}
							}
						}

						signal?.removeEventListener("abort", onAbort);

						if (entries.length === 0) {
							resolve({ content: [{ type: "text", text: "(empty directory)" }], details: undefined });
							return;
						}

						// Format output: indent by depth, add '/' suffix for directories.
						const results = entries.map((entry) => {
							const indent = "  ".repeat(entry.depth - 1);
							const suffix = entry.type === "dir" ? "/" : "";
							return `${indent}${entry.path}${suffix}`;
						});

						const rawOutput = results.join("\n");
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						let output = truncation.content;
						const details: TreeToolDetails = {
							entries: entries.map((entry) => ({
								path: entry.path,
								name: entry.name,
								type: entry.type,
								depth: entry.depth,
							})),
						};
						const notices: string[] = [];
						if (entryLimitReached) {
							notices.push(`${DEFAULT_LIMIT} entries limit reached. Use limit=${DEFAULT_LIMIT * 2} for more`);
							details.entryLimitReached = DEFAULT_LIMIT;
						}
						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}
						if (notices.length > 0) {
							output += `\n\n[${notices.join(". ")}]`;
						}

						resolve({
							content: [{ type: "text", text: output }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (e) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatTreeCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatTreeResult(result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createTreeTool(cwd: string, options?: TreeToolOptions): AgentTool<typeof treeSchema> {
	return wrapToolDefinition(createTreeToolDefinition(cwd, options));
}
