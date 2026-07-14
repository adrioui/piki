// packages/coding-agent/src/core/util/gitignore-walker.ts

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import ignore from "ignore";

/** The Ignore filter type, inferred from the `ignore` package. */
export type Ignore = ReturnType<typeof ignore>;

/** Directories always excluded before gitignore (never descended into). */
export const ALWAYS_EXCLUDED = new Set([".git", ".vcs"]);

/** Default gitignore patterns applied when respectGitignore is enabled. */
export const DEFAULT_IGNORE_PATTERNS = [
	"node_modules",
	"dist",
	"build",
	"out",
	"__pycache__",
	".pytest_cache",
	".next",
	".nuxt",
	"coverage",
	".turbo",
	".cache",
	"target",
	"vendor",
];

export interface WalkEntry {
	fullPath: string;
	relativePath: string;
	name: string;
	type: "dir" | "file";
	depth: number;
	size?: number;
	mtimeMs?: number;
}

export interface WalkOptions {
	respectGitignore?: boolean; // default true
	collectSizes?: boolean; // default false
	collectMtimes?: boolean; // default false
	maxDepth?: number;
	followSymlinks?: boolean; // default false (SKIP symlinks)
}

/** Rebase a gitignore pattern against a relative dir path. */
export function rebasePattern(pattern: string, relativeDirPath: string): string {
	const isNegated = pattern.startsWith("!");
	const p = isNegated ? pattern.slice(1) : pattern;
	const dirOnly = p.endsWith("/");
	const core = dirOnly ? p.slice(0, -1) : p;
	const anchored = core.startsWith("/");
	const coreNoLead = anchored ? core.slice(1) : core;
	const hasSlash = coreNoLead.includes("/");
	const base = relativeDirPath.replace(/\\/g, "/");
	let rebased: string;
	if (anchored) {
		rebased = base ? `${base}/${coreNoLead}` : coreNoLead;
	} else if (!hasSlash) {
		rebased = base ? `${base}/**/${coreNoLead}` : coreNoLead;
	} else {
		rebased = base ? `${base}/${coreNoLead}` : coreNoLead;
	}
	if (dirOnly && !rebased.endsWith("/")) {
		rebased += "/";
	}
	return isNegated ? `!${rebased}` : rebased;
}

/** Parse a directory's .gitignore, rebasing patterns to the given relative dir. */
export async function parseGitignore(dir: string, relativeDirPath: string): Promise<string[]> {
	try {
		const content = await readFile(join(dir, ".gitignore"), "utf8");
		const patterns: string[] = [];
		for (let line of content.split("\n")) {
			line = line.trim();
			if (line === "" || line.startsWith("#")) continue;
			patterns.push(rebasePattern(line, relativeDirPath));
		}
		return patterns;
	} catch {
		return [];
	}
}

/** Build the default ignore filter (DEFAULT_IGNORE_PATTERNS). */
export function createDefaultIgnore(): Ignore {
	return ignore().add(DEFAULT_IGNORE_PATTERNS);
}

/** Async depth-first walk respecting nested .gitignore. */
export async function walk(rootPath: string, opts: WalkOptions = {}): Promise<WalkEntry[]> {
	const defaults = {
		respectGitignore: opts.respectGitignore ?? true,
		collectSizes: opts.collectSizes ?? false,
		collectMtimes: opts.collectMtimes ?? false,
		maxDepth: opts.maxDepth,
		followSymlinks: opts.followSymlinks ?? false,
	};
	return walkInternal(
		rootPath,
		rootPath,
		0,
		defaults.maxDepth,
		defaults.respectGitignore ? createDefaultIgnore() : undefined,
		defaults,
	);
}

async function walkInternal(
	dirPath: string,
	basePath: string,
	depth: number,
	maxDepth: number | undefined,
	currentIgnore: Ignore | undefined,
	opts: {
		respectGitignore: boolean;
		collectSizes: boolean;
		collectMtimes: boolean;
		followSymlinks: boolean;
	},
): Promise<WalkEntry[]> {
	if (maxDepth !== undefined && depth > maxDepth) return [];

	let ignoreFilter = currentIgnore;
	if (opts.respectGitignore) {
		const relativeDirPath = relative(basePath, dirPath);
		const patterns = await parseGitignore(dirPath, relativeDirPath);
		if (patterns.length > 0) {
			ignoreFilter = currentIgnore ? ignore().add(currentIgnore).add(patterns) : ignore().add(patterns);
		}
	}

	let items: Dirent[];
	try {
		items = await readdir(dirPath, { withFileTypes: true });
	} catch {
		return [];
	}

	const entries: WalkEntry[] = [];
	const subdirs: string[] = [];
	const fileStatPromises: Promise<void>[] = [];

	for (const item of items) {
		if (ALWAYS_EXCLUDED.has(item.name)) continue;
		if (!opts.followSymlinks && item.isSymbolicLink()) continue;

		const fullPath = join(dirPath, item.name);
		const relativePath = relative(basePath, fullPath);
		if (ignoreFilter?.ignores(relativePath)) continue;

		const entry: WalkEntry = {
			fullPath,
			relativePath,
			name: item.name,
			type: item.isDirectory() ? "dir" : "file",
			depth,
		};
		entries.push(entry);

		if (item.isDirectory()) {
			subdirs.push(fullPath);
		} else if (opts.collectSizes || opts.collectMtimes) {
			fileStatPromises.push(
				stat(fullPath)
					.then((s) => {
						if (opts.collectSizes) entry.size = s.size;
						if (opts.collectMtimes) entry.mtimeMs = s.mtimeMs;
					})
					.catch(() => {}),
			);
		}
	}

	const [, ...subResults] = await Promise.all([
		Promise.all(fileStatPromises),
		...subdirs.map((sub) => walkInternal(sub, basePath, depth + 1, maxDepth, ignoreFilter, opts)),
	]);

	for (const subEntries of subResults) {
		entries.push(...subEntries);
	}

	return entries;
}
