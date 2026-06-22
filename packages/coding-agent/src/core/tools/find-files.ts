/**
 * find_files tool - Invokes the finder subagent to search the codebase.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { getSubagentSpec } from "../subagent/registry.ts";
import { runSubagent, type SubagentTool } from "../subagent/runtime.ts";

const findFilesSchema = Type.Object({
	query: Type.String({ description: "Search query describing what to find in the codebase" }),
});

export type FindFilesInput = Static<typeof findFilesSchema>;

export interface CreateFindFilesToolDefinitionOptions {
	cwd: string;
	model: Model<string> | (() => Model<string> | undefined);
	tools: SubagentTool[];
}

/**
 * Create the find_files tool definition.
 *
 * Requires a model reference (or factory) and the available subagent-accessible tools.
 */
export function createFindFilesToolDefinition(
	options: CreateFindFilesToolDefinitionOptions,
): ToolDefinition<typeof findFilesSchema> {
	return {
		name: "find_files",
		label: "Find Files",
		description:
			"Search the codebase using the finder subagent. Delegates to grep, find, read, ls, and bash tools to locate relevant files and return a summary.",
		promptSnippet: "Search the codebase for files matching a query",
		promptGuidelines: [
			"The find_files tool delegates to a subagent that uses grep, find, read, ls, and bash. Use it when you need to locate specific code patterns, definitions, or file structures.",
		],
		parameters: findFilesSchema,
		execute: async (
			_toolCallId: string,
			params: Static<typeof findFilesSchema>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> => {
			try {
				const spec = getSubagentSpec("finder");
				if (!spec) {
					return {
						content: [{ type: "text" as const, text: "Error: finder subagent spec not found" }],
						details: {},
					};
				}

				const resolvedModel = typeof options.model === "function" ? options.model() : options.model;
				if (!resolvedModel) {
					return {
						content: [{ type: "text" as const, text: "Error: no model available for finder subagent" }],
						details: {},
					};
				}

				const result = await runSubagent(
					{
						model: resolvedModel,
						systemPrompt: spec.systemPrompt,
						userMessage: params.query,
						allowedTools: spec.allowedTools,
						tools: options.tools,
					},
					_signal,
				);

				if (result.error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Finder subagent error: ${result.error}`,
							},
						],
						details: {
							query: params.query,
							error: result.error,
							turns: result.turns,
						},
					};
				}

				return {
					content: [{ type: "text" as const, text: result.text || "No results found." }],
					details: {
						query: params.query,
						turns: result.turns,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to run finder subagent: ${message}` }],
					details: { error: message },
				};
			}
		},
	};
}
