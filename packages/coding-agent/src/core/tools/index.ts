export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
	createShellTool,
	createShellToolDefinition,
	type ShellToolInput,
} from "./bash.ts";
export { type CompactToolOptions, createCompactToolDefinition } from "./compact.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGitTool,
	createGitToolDefinition,
	type GitToolDetails,
	type GitToolInput,
} from "./git.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export { createQueryImageToolDefinition, type QueryImageToolOptions } from "./query-image.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export { createSkillToolDefinition, type SkillToolOptions } from "./skill.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export { createViewTool, createViewToolDefinition, type ViewToolInput, type ViewToolOptions } from "./view.ts";
export { createWebFetchToolDefinition, type WebFetchInput } from "./web-fetch.ts";
export { createWebSearchToolDefinition, type WebSearchInput } from "./web-search.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@piki/agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createShellTool,
	createShellToolDefinition,
} from "./bash.ts";
import { type CompactToolOptions, createCompactToolDefinition } from "./compact.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGitToolDefinition } from "./git.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createQueryImageToolDefinition, type QueryImageToolOptions } from "./query-image.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createSkillToolDefinition, type SkillToolOptions } from "./skill.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createViewToolDefinition, type ViewToolOptions } from "./view.ts";
import { createWebFetchToolDefinition } from "./web-fetch.ts";
import { createWebSearchToolDefinition } from "./web-search.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;

/** Role-control, task, and goal tool names created via `createRoleControlTool`. */
export type RoleControlToolName =
	| "spawn_worker"
	| "kill_worker"
	| "message_worker"
	| "reassign_worker"
	| "create_task"
	| "update_task"
	| "finish_goal"
	| "message_advisor"
	| "pass"
	| "escalate";

/**
 * Full set of tool names the session can register. Core tools (returned by the
 * `createAll*` maps) plus role-control/task/goal tools.
 */
export type AllToolName =
	| ToolName
	| RoleControlToolName
	| "scratchpad_save"
	| "scratchpad_load"
	| "checkpoint_changes"
	| "checkpoint_rollback"
	| "restore_snapshot";
/** Core tool names created by `createTool`/`createToolDefinition` and returned by the `createAll*` maps. */
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "git"
	| "shell"
	| "compact"
	| "web_search"
	| "web_fetch"
	| "query_image"
	| "skill"
	| "view";
export const allToolNames: Set<AllToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"git",
	"shell",
	"compact",
	"web_search",
	"web_fetch",
	"query_image",
	"skill",
	"view",
	"scratchpad_save",
	"scratchpad_load",
	"checkpoint_changes",
	"checkpoint_rollback",
	"restore_snapshot",
	"spawn_worker",
	"kill_worker",
	"message_worker",
	"reassign_worker",
	"create_task",
	"update_task",
	"finish_goal",
	"message_advisor",
	"pass",
	"escalate",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	/** Scratchpad directory, used by tools to resolve $M/ paths. */
	scratchpadPath?: string;
	/** Options for the compact tool. */
	compact?: CompactToolOptions;
	/** Options for the query_image tool. */
	queryImage?: QueryImageToolOptions;
	/** Options for the view tool. */
	view?: ViewToolOptions;
	/** Options for the skill tool. */
	skill?: SkillToolOptions;
	/** Options for the web_search tool. */
	webSearch?: Record<string, never>;
	/** Options for the web_fetch tool. */
	webFetch?: Record<string, never>;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, { ...options?.read, scratchpadPath: options?.scratchpadPath ?? "" });
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, { ...options?.edit, scratchpadPath: options?.scratchpadPath ?? "" });
		case "write":
			return createWriteToolDefinition(cwd, { ...options?.write, scratchpadPath: options?.scratchpadPath ?? "" });
		case "grep":
			return createGrepToolDefinition(cwd, { ...options?.grep, scratchpadPath: options?.scratchpadPath ?? "" });
		case "find":
			return createFindToolDefinition(cwd, { ...options?.find, scratchpadPath: options?.scratchpadPath ?? "" });
		case "ls":
			return createLsToolDefinition(cwd, { ...options?.ls, scratchpadPath: options?.scratchpadPath ?? "" });
		case "git":
			return createGitToolDefinition(cwd);
		case "shell":
			return createShellToolDefinition(cwd, options?.bash);
		case "compact":
			return createCompactToolDefinition(options?.compact);
		case "web_search":
			return createWebSearchToolDefinition();
		case "web_fetch":
			return createWebFetchToolDefinition();
		case "query_image":
			return createQueryImageToolDefinition(cwd, options?.queryImage);
		case "view":
			return createViewToolDefinition(cwd, { ...options?.view, scratchpadPath: options?.scratchpadPath ?? "" });
		case "skill":
			return createSkillToolDefinition(options?.skill);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, { ...options?.read, scratchpadPath: options?.scratchpadPath ?? "" });
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, { ...options?.edit, scratchpadPath: options?.scratchpadPath ?? "" });
		case "write":
			return createWriteTool(cwd, { ...options?.write, scratchpadPath: options?.scratchpadPath ?? "" });
		case "grep":
			return createGrepTool(cwd, { ...options?.grep, scratchpadPath: options?.scratchpadPath ?? "" });
		case "find":
			return createFindTool(cwd, { ...options?.find, scratchpadPath: options?.scratchpadPath ?? "" });
		case "ls":
			return createLsTool(cwd, { ...options?.ls, scratchpadPath: options?.scratchpadPath ?? "" });
		case "git":
			return wrapDefined(createGitToolDefinition(cwd));
		case "shell":
			return createShellTool(cwd, options?.bash);
		case "compact":
			return wrapDefined(createCompactToolDefinition(options?.compact));
		case "web_search":
			return wrapDefined(createWebSearchToolDefinition());
		case "web_fetch":
			return wrapDefined(createWebFetchToolDefinition());
		case "query_image":
			return wrapDefined(createQueryImageToolDefinition(cwd, options?.queryImage));
		case "view":
			return wrapDefined(
				createViewToolDefinition(cwd, { ...options?.view, scratchpadPath: options?.scratchpadPath ?? "" }),
			);
		case "skill":
			return wrapDefined(createSkillToolDefinition(options?.skill));
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

/** Adapter that wraps a ToolDefinition into an AgentTool (AgentTool<any>). */
function wrapDefined(def: ToolDefinition<any, any>): Tool {
	return wrapToolDefinition(def);
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, { ...options?.read, scratchpadPath: options?.scratchpadPath ?? "" }),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, { ...options?.edit, scratchpadPath: options?.scratchpadPath ?? "" }),
		createWriteToolDefinition(cwd, { ...options?.write, scratchpadPath: options?.scratchpadPath ?? "" }),
		createGitToolDefinition(cwd),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, { ...options?.read, scratchpadPath: options?.scratchpadPath ?? "" }),
		createGrepToolDefinition(cwd, { ...options?.grep, scratchpadPath: options?.scratchpadPath ?? "" }),
		createFindToolDefinition(cwd, { ...options?.find, scratchpadPath: options?.scratchpadPath ?? "" }),
		createLsToolDefinition(cwd, { ...options?.ls, scratchpadPath: options?.scratchpadPath ?? "" }),
		createGitToolDefinition(cwd),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, { ...options?.read, scratchpadPath: options?.scratchpadPath ?? "" }),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, { ...options?.edit, scratchpadPath: options?.scratchpadPath ?? "" }),
		write: createWriteToolDefinition(cwd, { ...options?.write, scratchpadPath: options?.scratchpadPath ?? "" }),
		grep: createGrepToolDefinition(cwd, { ...options?.grep, scratchpadPath: options?.scratchpadPath ?? "" }),
		find: createFindToolDefinition(cwd, { ...options?.find, scratchpadPath: options?.scratchpadPath ?? "" }),
		ls: createLsToolDefinition(cwd, { ...options?.ls, scratchpadPath: options?.scratchpadPath ?? "" }),
		git: createGitToolDefinition(cwd),
		shell: createShellToolDefinition(cwd, options?.bash),
		compact: createCompactToolDefinition(options?.compact),
		web_search: createWebSearchToolDefinition(),
		web_fetch: createWebFetchToolDefinition(),
		query_image: createQueryImageToolDefinition(cwd, options?.queryImage),
		skill: createSkillToolDefinition(options?.skill),
		view: createViewToolDefinition(cwd, { ...options?.view, scratchpadPath: options?.scratchpadPath ?? "" }),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, { ...options?.read, scratchpadPath: options?.scratchpadPath ?? "" }),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, { ...options?.edit, scratchpadPath: options?.scratchpadPath ?? "" }),
		createWriteTool(cwd, { ...options?.write, scratchpadPath: options?.scratchpadPath ?? "" }),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, { ...options?.read, scratchpadPath: options?.scratchpadPath ?? "" }),
		createGrepTool(cwd, { ...options?.grep, scratchpadPath: options?.scratchpadPath ?? "" }),
		createFindTool(cwd, { ...options?.find, scratchpadPath: options?.scratchpadPath ?? "" }),
		createLsTool(cwd, { ...options?.ls, scratchpadPath: options?.scratchpadPath ?? "" }),
		wrapDefined(createGitToolDefinition(cwd)),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, { ...options?.read, scratchpadPath: options?.scratchpadPath ?? "" }),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, { ...options?.edit, scratchpadPath: options?.scratchpadPath ?? "" }),
		write: createWriteTool(cwd, { ...options?.write, scratchpadPath: options?.scratchpadPath ?? "" }),
		grep: createGrepTool(cwd, { ...options?.grep, scratchpadPath: options?.scratchpadPath ?? "" }),
		find: createFindTool(cwd, { ...options?.find, scratchpadPath: options?.scratchpadPath ?? "" }),
		ls: createLsTool(cwd, { ...options?.ls, scratchpadPath: options?.scratchpadPath ?? "" }),
		git: wrapDefined(createGitToolDefinition(cwd)),
		shell: createShellTool(cwd, options?.bash),
		compact: wrapDefined(createCompactToolDefinition(options?.compact)),
		web_search: wrapDefined(createWebSearchToolDefinition()),
		web_fetch: wrapDefined(createWebFetchToolDefinition()),
		query_image: wrapDefined(createQueryImageToolDefinition(cwd, options?.queryImage)),
		skill: wrapDefined(createSkillToolDefinition(options?.skill)),
		view: wrapDefined(
			createViewToolDefinition(cwd, { ...options?.view, scratchpadPath: options?.scratchpadPath ?? "" }),
		),
	};
}
