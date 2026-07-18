/**
 * Worker tool registry scoping — filters tools based on ROLE_DEFINITIONS toolkit field.
 *
 * - workerBase: read, shell, edit, write, grep, find, ls, web_search, web_fetch, skill, compact, scratchpad_save, scratchpad_load
 * - criticBase: read, grep, find, ls, bash (read-only)
 * - Leader-only tools (spawn_worker, kill_worker, etc.) are NOT available to any worker
 */

import { ROLE_DEFINITIONS } from "@piki/event-core";
import type { WorkerTool } from "./worker-session.ts";

const WORKER_BASE_TOOLS = new Set([
	"read",
	"shell",
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
	"view",
	"query_image",
	"checkpoint_changes",
	"checkpoint_rollback",
]);

const CRITIC_BASE_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"shell",
	"write",
	"edit",
	"view",
	"query_image",
	"tree",
	"compact",
]);

// Observer may only pass or escalate — no filesystem, web, or worker-management tools.
const OBSERVER_TOOLKIT_TOOLS = new Set(["pass", "escalate"]);

// Compact role runs its own compaction pipeline; it needs no standard tools.
const COMPACT_TOOLKIT_TOOLS = new Set<string>();

// `checkpoint_changes` and `checkpoint_rollback` are exposed to workers
// (alpha22: workers can snapshot/rollback their own changes). They remain in
// LEADER_ONLY_TOOLS only as a defense-in-depth gate for the observer toolkit.

const LEADER_ONLY_TOOLS = new Set([
	"spawn_worker",
	"kill_worker",
	"message_worker",
	"reassign_worker",
	"create_task",
	"update_task",
	"message_advisor",
	"finish_goal",
	"pass",
	"escalate",
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
const WEB_TOOL_NAMES = new Set(["web_search", "web_fetch", "query_image"]);

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
