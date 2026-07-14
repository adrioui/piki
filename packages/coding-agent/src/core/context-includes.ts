/**
 * AGENTS.md / CLAUDE.md @file includes and glob-scoped guidance.
 *
 * Supports Amp-style `@path` mentions inside project context files:
 * - `@relative/path.md` resolves relative to the file containing the mention.
 * - `@~/path` and `@/abs/path` resolve via home / absolute.
 * - Mentions inside fenced code blocks are ignored.
 * - Cycles and duplicate includes are prevented.
 * - Total included content is size-bounded to avoid prompt injection bloat.
 *
 * Glob-scoped guidance: an included markdown file may declare YAML frontmatter
 * with a `globs` array (e.g. src globs ending in .ts) so it only applies when
 * relevant files are touched. `filterGlobScopedDocs` filters parsed docs by a
 * set of file paths. This module exposes parsing + filtering; dynamic
 * activation (tracking touched files) is intentionally deferred unless the
 * caller wires it.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { minimatch } from "minimatch";
import { parseFrontmatter } from "../utils/frontmatter.ts";

/** Hard cap on the total expanded bytes of @file includes for one context file. */
export const DEFAULT_MAX_INCLUDE_BYTES = 100_000;
/** Hard cap on a single included file's bytes. */
export const DEFAULT_MAX_FILE_BYTES = 64_000;
/** Hard cap on include depth to bound recursion. */
export const DEFAULT_MAX_DEPTH = 10;

export interface AtFileIncludeOptions {
	maxIncludeBytes?: number;
	maxFileBytes?: number;
	maxDepth?: number;
	/** Home directory for `@~/path` expansion. Defaults to os.homedir(). */
	homeDir?: string;
}

export interface AtFileIncludeResult {
	/** The original content with @path mentions replaced by included content. */
	content: string;
	/** Files actually included (canonical absolute paths). */
	included: string[];
	/** Non-fatal issues encountered (missing files, size limits, etc.). */
	warnings: string[];
}

/**
 * Strip fenced code blocks (``` ... ``` and~~~ ... ~~~) from markdown so
 * `@mentions` inside them are ignored. Returns text with code blocks replaced
 * by empty lines (preserving line count for any line-based logic).
 */
export function stripFencedCodeBlocks(text: string): string {
	const fence = /(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(\n\2)(?=\n|$)/g;
	return text.replace(fence, (_match, prefix) => `${prefix}`);
}

const AT_MENTION =
	/(^|[^\w`])@(~?\/[^@\s`<>|]+|\/[^@\s`<>|]+|[^\s@`<>|]+\.[A-Za-z0-9]+(?:[\\/][^\s@`<>|]+)*|[\w-]+(?:[\\/][^\s@`<>|]+)+)/g;

/**
 * Extract raw @path tokens from markdown content, ignoring fenced code blocks.
 * Returns the matched path strings (with leading `@` removed and `~` preserved).
 */
export function extractAtMentions(content: string): string[] {
	const cleaned = stripFencedCodeBlocks(content);
	const matches = new Set<string>();
	AT_MENTION.lastIndex = 0;
	let match = AT_MENTION.exec(cleaned);
	while (match !== null) {
		// match[2] is the path portion after @
		matches.add(match[2]);
		match = AT_MENTION.exec(cleaned);
	}
	return Array.from(matches);
}

function resolveMentionPath(rawPath: string, contextDir: string, homeDir: string): string {
	const path = rawPath.trim();
	// @~/path form
	if (path.startsWith("~/")) {
		return resolvePath(homeDir, path.slice(2));
	}
	if (path === "~") {
		return homeDir;
	}
	if (isAbsolute(path)) {
		return resolvePath(path);
	}
	return resolvePath(contextDir, path);
}

function isLikelyPath(rawPath: string): boolean {
	// Avoid matching @mentions, emails, and bare words that are not file paths.
	// Require either an extension, a path separator, a leading ~/, or leading /.
	if (rawPath.startsWith("~/") || rawPath.startsWith("/")) return true;
	if (rawPath.includes("/") || rawPath.includes("\\")) return true;
	// has an extension like .md, .txt
	return /\.[A-Za-z0-9]{1,8}$/.test(rawPath);
}

/**
 * Expand @path mentions in a context file's content. Reads included files,
 * resolves relative to the context file, prevents cycles/duplicates, and bounds
 * total size. Returns the expanded content and the list of included files.
 *
 * Mentions that are not recognizable paths, point at missing files, or would
 * exceed limits are left as-is in the text (with a warning recorded).
 */
export function expandAtFileIncludes(
	content: string,
	contextFilePath: string,
	options: AtFileIncludeOptions = {},
): AtFileIncludeResult {
	const homeDir = options.homeDir ?? homedir();
	const maxIncludeBytes = options.maxIncludeBytes ?? DEFAULT_MAX_INCLUDE_BYTES;
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const contextDir = dirname(resolvePath(contextFilePath));

	const included: string[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();
	let totalBytes = 0;

	// Unified regex that matches fenced code blocks OR @mentions.
	// Fenced blocks are emitted verbatim; mentions outside fences are expanded.
	const fencePattern = "(^|\\n)(\\`{3,}|~{3,})[^\\n]*\\n([\\s\\S]*?)(\\n\\2)(?=\\n|$)";
	const FENCE_OR_MENTION = new RegExp(`${fencePattern}|${AT_MENTION.source}`, "gm");

	const expand = (mention: string, depth: number): string => {
		const resolved = resolveMentionPath(mention, contextDir, homeDir);
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(resolved);
		} catch {
			warnings.push(`@file include not found: ${mention} (resolved ${resolved})`);
			return `@${mention}`;
		}
		if (!stats.isFile()) {
			warnings.push(`@file include is not a file: ${mention} (resolved ${resolved})`);
			return `@${mention}`;
		}
		if (seen.has(resolved)) {
			// duplicate: drop the mention to avoid repeating content
			return "";
		}
		if (depth > maxDepth) {
			warnings.push(`@file include exceeded max depth ${maxDepth}: ${mention}`);
			return `@${mention}`;
		}

		let fileContent: string;
		try {
			fileContent = readFileSync(resolved, "utf-8");
		} catch (err) {
			warnings.push(`@file include unreadable: ${mention} (${err instanceof Error ? err.message : String(err)})`);
			return `@${mention}`;
		}

		if (fileContent.length > maxFileBytes) {
			warnings.push(`@file include truncated to ${maxFileBytes} bytes: ${mention} (was ${fileContent.length})`);
			fileContent = `${fileContent.slice(0, maxFileBytes)}\n... [truncated]`;
		}

		if (totalBytes + fileContent.length > maxIncludeBytes) {
			const remaining = Math.max(0, maxIncludeBytes - totalBytes);
			warnings.push(`@file include total size limit reached at ${mention}`);
			fileContent = remaining > 0 ? fileContent.slice(0, remaining) : "";
		}

		totalBytes += fileContent.length;
		seen.add(resolved);
		included.push(resolved);

		// Recursively expand nested includes in the included content, bounded by
		// depth. Scan the original content (preserving code blocks) for mentions.
		const nestedExpanded = expandMentionsInText(fileContent, depth + 1);

		const header = `<!-- included from ${mention} -->\n`;
		return `${header}${nestedExpanded}`;
	};

	/**
	 * Scan `text` for @mention tokens that appear outside fenced code blocks
	 * and expand them. Fenced code blocks are preserved verbatim.
	 */
	function expandMentionsInText(text: string, depth: number): string {
		FENCE_OR_MENTION.lastIndex = 0;
		let lastIndex = 0;
		const out: string[] = [];
		let m = FENCE_OR_MENTION.exec(text);
		while (m !== null) {
			if (m[2]) {
				// This is a fenced code block match — keep it verbatim.
				m = FENCE_OR_MENTION.exec(text);
				continue;
			}
			// This is an @mention match. m[6] is the path capture group.
			const prefix = m[5] ?? "";
			const mention = m[6];
			if (mention && isLikelyPath(mention)) {
				const matchStart = m.index + prefix.length;
				out.push(text.slice(lastIndex, matchStart));
				out.push(expand(mention, depth));
				lastIndex = m.index + m[0].length;
			}
			m = FENCE_OR_MENTION.exec(text);
		}
		out.push(text.slice(lastIndex));
		return out.join("");
	}

	// Scan the original content for @mention tokens that appear outside
	// fenced code blocks and expand them. Fenced code blocks are preserved
	// verbatim in the output.
	const contentResult = expandMentionsInText(content, 0);

	return { content: contentResult, included, warnings };
}

// ---------------------------------------------------------------------------
// Glob-scoped guidance
// ---------------------------------------------------------------------------

export interface GlobScopedDoc {
	/** Original path of the doc (for attribution). */
	path: string;
	/** Parsed body (frontmatter stripped). */
	body: string;
	/** Glob patterns from frontmatter `globs`. When present, the doc is conditional. */
	globs: string[];
	/** Whether this doc is always included (no globs declared). */
	alwaysInclude: boolean;
}

/**
 * Parse a markdown doc into a GlobScopedDoc, extracting a `globs` frontmatter
 * array if present. Docs without globs are always included.
 */
export function parseGlobScopedDoc(content: string, path: string): GlobScopedDoc {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const globsRaw = frontmatter.globs;
	const globs = Array.isArray(globsRaw)
		? globsRaw.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
		: typeof globsRaw === "string" && globsRaw.trim()
			? [globsRaw.trim()]
			: [];
	return { path, body, globs, alwaysInclude: globs.length === 0 };
}

/**
 * Filter glob-scoped docs to those that apply to a set of touched file paths.
 * Docs with no globs are always included. A doc with globs is included when at
 * least one touched path matches at least one glob (minimatch).
 */
export function filterGlobScopedDocs(docs: GlobScopedDoc[], touchedPaths: string[]): GlobScopedDoc[] {
	if (touchedPaths.length === 0) {
		// No touched files known: include only always-include docs.
		return docs.filter((d) => d.alwaysInclude);
	}
	return docs.filter((doc) => {
		if (doc.alwaysInclude) return true;
		return doc.globs.some((pattern) => touchedPaths.some((p) => minimatch(p, pattern)));
	});
}
