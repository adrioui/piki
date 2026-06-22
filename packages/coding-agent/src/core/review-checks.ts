/**
 * Amp-style review checks: discovery + registry of `.agents/checks/*.md`
 * (and config-dir equivalents).
 *
 * A check file is markdown with YAML frontmatter:
 *   ---
 *   name: no-any             # required
 *   description: ...         # optional
 *   severity-default: medium # optional: low | medium | high | critical
 *   tools: [read, grep]      # optional extra tool names the check may use
 *   ---
 *   <reviewer instructions>
 *
 * Discovery scans `.agents/checks/` from the project root and ancestors, plus
 * `~/.config/agents/checks` and `~/.config/pi/checks` when they exist. This is
 * intentionally pure and synchronous so it can be tested without a network.
 */

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter.ts";

export type CheckSeverity = "low" | "medium" | "high" | "critical";

const VALID_SEVERITIES: ReadonlySet<string> = new Set(["low", "medium", "high", "critical"]);

export interface ReviewCheck {
	/** Stable identifier from frontmatter `name` (falls back to filename slug). */
	name: string;
	/** Human description from frontmatter (optional). */
	description?: string;
	/** Default severity from frontmatter (optional). */
	severityDefault?: CheckSeverity;
	/** Extra tool names the check subagent may use beyond the read-only baseline. */
	tools: string[];
	/** Reviewer instructions body (frontmatter stripped). */
	instructions: string;
	/** Filesystem path the check was loaded from. */
	path: string;
}

export interface ReviewCheckDiagnostic {
	type: "error" | "warning";
	message: string;
	path: string;
}

export interface LoadReviewChecksOptions {
	/** Project root to scan for `.agents/checks/`. */
	cwd: string;
	/** Agent config dir (e.g. ~/.pi/agent). Scanned for `checks/`. Optional. */
	agentDir?: string;
}

/** Standard read-only baseline tools a check subagent may always use. */
export const CHECK_BASELINE_TOOLS = ["read", "grep", "find", "ls", "bash"];

function isMarkdown(name: string): boolean {
	return name.toLowerCase().endsWith(".md");
}

function slugFromFilename(name: string): string {
	const base = name.replace(/\.md$/i, "");
	return base
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function normalizeSeverity(value: unknown): CheckSeverity | undefined {
	if (typeof value !== "string") return undefined;
	const lower = value.toLowerCase();
	return VALID_SEVERITIES.has(lower) ? (lower as CheckSeverity) : undefined;
}

function parseCheckFile(filePath: string): ReviewCheck | ReviewCheckDiagnostic {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (err) {
		return {
			type: "error",
			message: `Failed to read check file: ${err instanceof Error ? err.message : String(err)}`,
			path: filePath,
		};
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
	const instructions = body.trim();

	const rawName = frontmatter.name;
	const name =
		typeof rawName === "string" && rawName.trim()
			? rawName.trim()
			: slugFromFilename(filePath.split(sep).pop() ?? "");
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;
	const severityDefault = normalizeSeverity(frontmatter["severity-default"] ?? frontmatter.severityDefault);
	const tools = Array.isArray(frontmatter.tools)
		? frontmatter.tools.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
		: [];

	return { name, description, severityDefault, tools, instructions, path: filePath };
}

function scanChecksDir(dir: string, into: ReviewCheck[], diagnostics: ReviewCheckDiagnostic[]): void {
	if (!existsSync(dir)) return;
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		diagnostics.push({
			type: "warning",
			message: `Failed to read checks directory: ${err instanceof Error ? err.message : String(err)}`,
			path: dir,
		});
		return;
	}

	for (const entry of entries) {
		// Follow symlinks to resolve file-ness.
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				isFile = statSync(join(dir, entry.name)).isFile();
			} catch {
				continue;
			}
		}
		if (!isFile || !isMarkdown(entry.name)) continue;
		const filePath = join(dir, entry.name);
		const parsed = parseCheckFile(filePath);
		if ("type" in parsed) {
			diagnostics.push(parsed);
		} else {
			into.push(parsed);
		}
	}
}

/**
 * Discover review checks.
 *
 * Search order (later matches win on name collisions, mirroring project-overrides-global):
 *   1. `~/.config/agents/checks` and `~/.config/pi/checks`
 *   2. `<agentDir>/checks`
 *   3. `.agents/checks` walking from cwd up to the filesystem root (nearest last)
 *
 * Duplicate names are deduped keeping the most specific (later) source.
 */
export function loadReviewChecks(options: LoadReviewChecksOptions): {
	checks: ReviewCheck[];
	diagnostics: ReviewCheckDiagnostic[];
} {
	const checks: ReviewCheck[] = [];
	const diagnostics: ReviewCheckDiagnostic[] = [];

	// 1. User config dirs.
	scanChecksDir(join(homedir(), ".config", "agents", "checks"), checks, diagnostics);
	scanChecksDir(join(homedir(), ".config", "pi", "checks"), checks, diagnostics);

	// 2. Agent dir checks.
	if (options.agentDir) {
		scanChecksDir(join(options.agentDir, "checks"), checks, diagnostics);
	}

	// 3. `.agents/checks` from cwd up to root (nearest/innermost scanned last).
	const root = resolve("/");
	let currentDir = resolve(options.cwd);
	const ancestorDirs: string[] = [];
	while (true) {
		ancestorDirs.push(currentDir);
		if (currentDir === root) break;
		const parent = resolve(currentDir, "..");
		if (parent === currentDir) break;
		currentDir = parent;
	}
	// Scan outermost first so the nearest (cwd) wins on collisions.
	for (let i = ancestorDirs.length - 1; i >= 0; i--) {
		scanChecksDir(join(ancestorDirs[i], ".agents", "checks"), checks, diagnostics);
	}

	// Dedupe by name, keeping the most specific source (last seen).
	const byName = new Map<string, ReviewCheck>();
	for (const check of checks) {
		byName.set(check.name, check);
	}

	return { checks: Array.from(byName.values()), diagnostics };
}

/**
 * Resolve the effective tool set for a check: the read-only baseline plus any
 * extra tools declared in the check frontmatter, intersected with the tools the
 * caller actually exposes to subagents.
 */
export function resolveCheckTools(check: ReviewCheck, availableToolNames: Iterable<string>): string[] {
	const available = new Set(availableToolNames);
	const effective: string[] = [];
	for (const name of [...CHECK_BASELINE_TOOLS, ...check.tools]) {
		if (available.has(name) && !effective.includes(name)) {
			effective.push(name);
		}
	}
	return effective;
}
