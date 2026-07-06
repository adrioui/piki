/**
 * Worker tool registry scoping — filters tools based on ROLE_DEFINITIONS toolkit field.
 *
 * - workerBase: read, bash, edit, write, grep, find, ls, web_search, web_fetch, skill, compact, scratchpad_save, scratchpad_load
 * - criticBase: read, grep, find, ls, bash (read-only)
 * - Leader-only tools (spawnWorker, killWorker, etc.) are NOT available to any worker
 */

import { ROLE_DEFINITIONS } from "@piki/event-core";
import type { WorkerTool } from "./worker-session.ts";

const WORKER_BASE_TOOLS = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"web_search",
	"web_fetch",
	"skill",
	"compact",
	"scratchpad_save",
	"scratchpad_load",
]);

const CRITIC_BASE_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);

// Observer may only pass or escalate — no filesystem, web, or worker-management tools.
const OBSERVER_TOOLKIT_TOOLS = new Set(["pass", "escalate"]);

// Compact role runs its own compaction pipeline; it needs no standard tools.
const COMPACT_TOOLKIT_TOOLS = new Set<string>();

// `checkpoint_changes` and `restore_snapshot` are also absent from WORKER_BASE_TOOLS.
// Keeping them here is defense-in-depth if the worker allowlist changes later.
const LEADER_ONLY_TOOLS = new Set([
	"spawnWorker",
	"killWorker",
	"messageWorker",
	"reassignWorker",
	"createTask",
	"updateTask",
	"messageAdvisor",
	"finishGoal",
	"pass",
	"escalate",
	"checkpoint_changes",
	"restore_snapshot",
]);

export interface FilterToolsForRoleOptions {
	includeHidden?: boolean;
	includeInternal?: boolean;
}

export function filterToolsForRole(
	role: string,
	allTools: WorkerTool[],
	options: FilterToolsForRoleOptions = {},
): WorkerTool[] {
	const def = (ROLE_DEFINITIONS as Record<string, { toolkit: string; webTools: boolean }>)[role];
	if (!def) {
		console.warn(`Unknown role: ${role}, returning all tools`);
	}
	const toolkit = def?.toolkit ?? "workerBase";
	const webToolsEnabled = def?.webTools ?? true;

	const allowedSet = getToolkit(toolkit);

	return allTools.filter((tool) => {
		// Observer toolkit tools (pass, escalate) are in LEADER_ONLY_TOOLS but must
		// still be available to observers. Only apply the leader-only gate for
		// non-observer toolkits.
		if (toolkit !== "observerToolkit" && LEADER_ONLY_TOOLS.has(tool.name)) return false;
		if (tool.hidden && !options.includeHidden) return false;
		if (tool.internal && !options.includeInternal) return false;

		// Apply webTools filter: exclude web tools if role doesn't have web access
		if (!webToolsEnabled && isWebTool(tool.name)) {
			return false;
		}

		return allowedSet.has(tool.name);
	});
}

/** Web-related tool names that require webTools: true */
const WEB_TOOL_NAMES = new Set(["web_search", "web_fetch"]);

function isWebTool(toolName: string): boolean {
	return WEB_TOOL_NAMES.has(toolName);
}

function getToolkit(toolkit: string): Set<string> {
	switch (toolkit) {
		case "criticBase":
			return CRITIC_BASE_TOOLS;
		case "observerToolkit":
			return OBSERVER_TOOLKIT_TOOLS;
		case "compactToolkit":
			return COMPACT_TOOLKIT_TOOLS;
		default:
			return WORKER_BASE_TOOLS;
	}
}
