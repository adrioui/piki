import { execFileSync } from "node:child_process";
import type { AgentTool } from "@piki/agent-core";
import { Text } from "@piki/tui";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { parsePorcelainV2 } from "../git-state.ts";
import { isGitRepo } from "../snapshot.ts";
import { getTextOutput, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const gitSchema = Type.Object({
	command: Type.Union(
		[Type.Literal("status"), Type.Literal("diff"), Type.Literal("log"), Type.Literal("show"), Type.Literal("blame")],
		{ description: "Read-only git subcommand to run." },
	),
	path: Type.Optional(
		Type.String({ description: "File or directory to scope the command to (diff/log/show/blame)." }),
	),
	ref: Type.Optional(
		Type.String({ description: "Ref/target: compare base for diff, range for log, object id for show." }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of commits for log (default: 20)." })),
	line: Type.Optional(Type.Number({ description: "Single line to blame (blame only)." })),
});

export type GitToolInput = Static<typeof gitSchema>;

const DEFAULT_LOG_LIMIT = 20;

export interface GitToolDetails {
	command: string;
	error?: boolean;
	truncation?: { truncated: boolean; maxBytes: number };
}

/** Reject args that could escape the cwd or inject shell metacharacters. */
function isSafeGitArg(value: string): boolean {
	if (!value) return false;
	// No absolute paths, parent traversal, or null/control chars.
	if (path.isAbsolute(value)) return false;
	if (value.includes("..")) return false;
	if (/[\x00-\x1f\x7f]/.test(value)) return false;
	// Reject shell metacharacters to keep the tool strictly argument-safe.
	if (/[;&|`$()<>\\"'*?[\]{}\s~!#]/.test(value)) return false;
	return true;
}

function resolveSafePath(value: string, cwd: string): string | undefined {
	if (!isSafeGitArg(value)) return undefined;
	return path.normalize(path.resolve(cwd, value));
}

function runGit(cwd: string, args: string[]): { stdout: string; code: number } {
	try {
		const stdout = execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 10000,
			maxBuffer: 20 * 1024 * 1024,
		});
		return { stdout, code: 0 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; status?: number };
		const stdout = e.stdout ?? "";
		const stderr = e.stderr ?? "";
		// git diff / show exit non-zero when there are differences; surface stdout.
		return { stdout: stdout || stderr, code: e.status ?? 1 };
	}
}

function formatGitCall(args: GitToolInput | undefined, theme: Theme, _cwd: string): string {
	const command = str(args?.command);
	const cmd = command ?? "git";
	const title = theme.fg("toolTitle", theme.bold("git"));
	let text = `${title} ${theme.fg("accent", cmd)}`;
	if (args?.ref) text += theme.fg("toolOutput", ` ${args.ref}`);
	if (args?.path) text += theme.fg("toolOutput", ` -- ${shortenPath(args.path)}`);
	if (args?.line !== undefined) text += theme.fg("toolOutput", ` L${args.line}`);
	if (args?.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
	return text;
}

function formatGitResult(
	result: { content: Array<{ type: string; text?: string }>; details?: GitToolDetails },
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
	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		text += `\n${theme.fg("warning", `[Truncated: ${formatSize(truncation.maxBytes)} limit]`)}`;
	}
	return text;
}

export function createGitToolDefinition(cwd: string): ToolDefinition<typeof gitSchema, GitToolDetails | undefined> {
	return {
		name: "git",
		label: "git",
		description:
			"Read-only git inspection. Supported commands: status (porcelain v2), diff, log, show, blame. Never modifies the repository. Prefer this over shelling out with bash for read-only git queries.",
		promptSnippet: "Inspect git state (status, diff, log, show, blame) — read-only",
		promptGuidelines: ["Prefer the git tool over shelling out with bash for read-only git queries."],
		executionMode: "parallel",
		parameters: gitSchema,
		async execute(
			_toolCallId,
			{ command, path: rawPath, ref, limit, line }: GitToolInput,
			_signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			if (!isGitRepo(cwd)) {
				return {
					content: [{ type: "text", text: `Git repository not found in ${cwd}` }],
					details: { command, error: true },
				};
			}

			let scopedPath: string | undefined;
			if (rawPath) {
				scopedPath = resolveSafePath(rawPath, cwd);
				if (!scopedPath) {
					return {
						content: [{ type: "text", text: `Unsafe or invalid path for git query: ${rawPath}` }],
						details: { command, error: true },
					};
				}
			}

			let args: string[];
			switch (command) {
				case "status": {
					args = ["status", "--porcelain=v2"];
					break;
				}
				case "diff": {
					args = ["diff"];
					if (ref) args.push(ref);
					if (scopedPath) args.push("--", scopedPath);
					break;
				}
				case "log": {
					const effectiveLimit = Math.max(1, limit ?? DEFAULT_LOG_LIMIT);
					args = ["log", "--oneline", `-n${effectiveLimit}`];
					if (scopedPath) args.push("--", scopedPath);
					break;
				}
				case "show": {
					const target = ref || "HEAD";
					args = ["show", target];
					if (scopedPath) args.push("--", scopedPath);
					break;
				}
				case "blame": {
					if (!scopedPath) {
						return {
							content: [{ type: "text", text: "blame requires a `path` argument." }],
							details: { command, error: true },
						};
					}
					args = ["blame"];
					if (typeof line === "number") args.push("-L", `${line},${line}`);
					args.push("--", scopedPath);
					break;
				}
			}

			const { stdout } = runGit(cwd, args);
			let text = stdout;
			// For status, reformat porcelain v2 into readable lines.
			if (command === "status" && text.trim().length > 0) {
				const entries = parsePorcelainV2(text);
				text = entries.map((e) => formatStatusLine(e)).join("\n");
			}

			const truncated = truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER });
			const details: GitToolDetails = { command };
			let output = truncated.content || "no output";
			if (truncated.truncated) {
				details.truncation = { truncated: true, maxBytes: truncated.maxBytes };
			}
			if (truncated.truncated) {
				output += `\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached]`;
			}
			return { content: [{ type: "text", text: output }], details };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGitCall(args, theme, cwd));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGitResult(result, options, theme, context.showImages));
			return text;
		},
	};
}

/** Render a porcelain v2 entry as a compact human-readable status line. */
function formatStatusLine(e: { x: string; y: string; path: string; oldPath?: string }): string {
	const code = `${e.x}${e.y}`;
	if (e.oldPath) {
		return `${code} ${e.oldPath} -> ${e.path}`;
	}
	return `${code} ${e.path}`;
}

export function createGitTool(cwd: string): AgentTool<typeof gitSchema> {
	return wrapToolDefinition(createGitToolDefinition(cwd));
}
