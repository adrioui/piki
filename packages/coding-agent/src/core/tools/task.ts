/**
 * task tool - Run a general isolated subagent to carry out a sub-task.
 *
 * The task subagent runs in its own context with a curated tool set. It returns
 * only its final summary to the calling agent. It cannot communicate with other
 * subagents. This is the pi analogue of Amp's Task tool.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { runSubagent, type SubagentTool } from "../subagent/runtime.ts";

const TASK_SYSTEM_PROMPT = [
	"You are a task subagent running inside a coding agent with an isolated context.",
	"You cannot see the parent conversation, so work only from the request you are given.",
	"You cannot communicate with other subagents.",
	"",
	"Do the work requested, then end with a concise summary of what you did, what changed, and any results or blockers.",
	"Only your final message is returned to the calling agent, so put the complete outcome in your final message.",
	"Follow the same coding, git, and workspace safety rules as the main agent: read before editing, keep edits surgical, never run destructive commands unless explicitly asked, and validate changes.",
].join("\n");

/**
 * Build a context firewall block containing project context for the subagent.
 * This helps the subagent understand the project state without seeing the parent conversation.
 */
export function buildContextFirewall(cwd: string, maxRecentCommits = 10, maxAgentsFiles = 5): string | null {
	const contextParts: string[] = [];

	// Add git branch and status
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		const status = execSync("git status --porcelain", {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		contextParts.push(`<project-state>`);
		contextParts.push(`  <branch>${branch}</branch>`);
		if (status) {
			const statusLines = status.split("\n").slice(0, 20);
			contextParts.push(`  <git-status>`);
			for (const line of statusLines) {
				contextParts.push(`    ${line}`);
			}
			contextParts.push(`  </git-status>`);
		}
		contextParts.push(`</project-state>`);
	} catch {
		// Git not available or not a git repo, skip
	}

	// Add recent commits
	try {
		const log = execSync(`git log --oneline -n ${maxRecentCommits}`, {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		if (log) {
			contextParts.push(`<recent-commits>`);
			for (const line of log.split("\n")) {
				contextParts.push(`  ${line}`);
			}
			contextParts.push(`</recent-commits>`);
		}
	} catch {
		// Git not available, skip
	}

	// Add AGENTS.md files from cwd and parent directories
	const agentsFiles: Array<{ path: string; content: string }> = [];
	const root = resolve("/");
	let currentDir = resolve(cwd);

	while (currentDir !== root && agentsFiles.length < maxAgentsFiles) {
		const agentsPath = join(currentDir, "AGENTS.md");
		if (existsSync(agentsPath)) {
			try {
				const content = readFileSync(agentsPath, "utf-8");
				const relPath = relative(cwd, agentsPath);
				agentsFiles.push({ path: relPath || "AGENTS.md", content });
			} catch {
				// Skip unreadable files
			}
		}

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	if (agentsFiles.length > 0) {
		contextParts.push(`<project-guidance>`);
		agentsFiles.forEach(({ path, content }) => {
			contextParts.push(`  <guidance-file path="${path}">`);
			contextParts.push(`    ${content}`);
			contextParts.push(`  </guidance-file>`);
		});
		contextParts.push(`</project-guidance>`);
	}

	if (contextParts.length === 0) {
		return null;
	}

	return `<project-context>\n${contextParts.join("\n")}\n</project-context>`;
}

/**
 * Default tools a task subagent may use when the caller does not restrict them.
 * Restricted to read/search/edit/write/bash, i.e. the productive coding surface.
 */
export const DEFAULT_TASK_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

const taskSchema = Type.Object({
	request: Type.String({
		description:
			"A self-contained description of the sub-task to perform. The task subagent does not see this conversation, so include goals, relevant file paths, constraints, and the expected outcome.",
	}),
	allowedTools: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Optional allowlist of tool names the task subagent may use (e.g. ["read", "grep", "bash"]). Defaults to read, grep, find, ls, bash, edit, write. The caller can further restrict this; tools not exposed to the main agent are never available to the subagent.',
		}),
	),
	maxTurns: Type.Optional(
		Type.Number({
			description: "Optional maximum number of agent turns for the subagent (default: 15).",
		}),
	),
});

export type TaskInput = Static<typeof taskSchema>;

export interface CreateTaskToolDefinitionOptions {
	cwd: string;
	model: Model<string> | (() => Model<string> | undefined);
	/** All tools the subagent could use, already filtered to caller permissions. */
	tools: SubagentTool[];
	/**
	 * Names of tools the main agent is allowed to delegate. The task subagent's
	 * effective tool set is the intersection of this with the requested allowlist
	 * (or DEFAULT_TASK_TOOLS) and the provided `tools`.
	 */
	delegatableToolNames: string[];
	defaultMaxTurns?: number;
}

/**
 * Create the task tool definition.
 *
 * The subagent only ever receives tools that are (a) present in `tools`,
 * (b) listed in `delegatableToolNames`, and (c) in the per-call allowlist (or
 * DEFAULT_TASK_TOOLS when none is given). This keeps edit/write unavailable
 * unless the caller explicitly permits them.
 */
export function createTaskToolDefinition(options: CreateTaskToolDefinitionOptions): ToolDefinition<typeof taskSchema> {
	const defaultMaxTurns = options.defaultMaxTurns ?? 15;
	const delegatable = new Set(options.delegatableToolNames);
	const availableToolNames = new Set(options.tools.map((t) => t.name));

	return {
		name: "task",
		label: "Task",
		description:
			"Run an isolated subagent to perform a sub-task (investigate, implement, or verify) and return only its final summary. Give it a self-contained request. Optionally restrict its tools (default: read, grep, find, ls, bash, edit, write) and max turns. Use it to keep focused work out of the main context.",
		promptSnippet: "Delegate a self-contained sub-task to an isolated subagent",
		promptGuidelines: [
			"Give task a self-contained request with goals, file paths, and the expected outcome; the subagent does not see this conversation.",
			"Restrict task tools to the minimum needed (e.g. read/search only for investigation) so it cannot make unintended changes.",
			"task returns only its final summary, so ask it to report what it changed and how it validated the result.",
			"Do not use task for work you can do faster with a single read/search; use it for multi-step or context-heavy work.",
		],
		parameters: taskSchema,
		execute: async (
			_toolCallId: string,
			params: Static<typeof taskSchema>,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> => {
			try {
				const requested =
					params.allowedTools && params.allowedTools.length > 0 ? params.allowedTools : DEFAULT_TASK_TOOLS;
				// Effective tool set: requested AND delegatable AND actually available.
				const effectiveAllowedTools = requested.filter(
					(name) => delegatable.has(name) && availableToolNames.has(name),
				);

				const maxTurns = params.maxTurns ?? defaultMaxTurns;

				const resolvedModel = typeof options.model === "function" ? options.model() : options.model;
				if (!resolvedModel) {
					return {
						content: [{ type: "text" as const, text: "Error: no model available for task subagent" }],
						details: {},
					};
				}

				// Build context firewall and inject into user message
				const contextBlock = buildContextFirewall(options.cwd);
				const enhancedRequest = contextBlock ? `${contextBlock}\n\n${params.request}` : params.request;

				const result = await runSubagent(
					{
						model: resolvedModel,
						systemPrompt: TASK_SYSTEM_PROMPT,
						userMessage: enhancedRequest,
						allowedTools: effectiveAllowedTools,
						tools: options.tools,
						maxTurns,
					},
					signal,
				);

				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Task subagent error: ${result.error}` }],
						details: {
							allowedTools: effectiveAllowedTools,
							maxTurns,
							error: result.error,
							turns: result.turns,
						},
					};
				}

				return {
					content: [{ type: "text" as const, text: result.text || "Task subagent returned no summary." }],
					details: { allowedTools: effectiveAllowedTools, maxTurns, turns: result.turns },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to run task subagent: ${message}` }],
					details: { error: message },
				};
			}
		},
	};
}
