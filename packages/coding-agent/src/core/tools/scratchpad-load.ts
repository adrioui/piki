/**
 * scratchpad_load tool: Load or search artifacts from the session scratchpad.
 */

import type { AgentToolResult } from "@piki/agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { ScratchpadCategory, ScratchpadManager } from "../scratchpad-manager.ts";

const SCRATCHPAD_CATEGORIES: ScratchpadCategory[] = ["designs", "plans", "reports", "results", "thoughts", "processes"];

const scratchpadLoadSchema = Type.Object({
	query: Type.Optional(Type.String({ description: "Search query to match against artifact titles and content" })),
	category: Type.Optional(
		Type.Union(
			SCRATCHPAD_CATEGORIES.map((c) => Type.Literal(c)),
			{ description: "Filter by category (designs, plans, reports, results, thoughts, processes)" },
		),
	),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of artifacts to return (default: 10)" })),
});

export type ScratchpadLoadInput = Static<typeof scratchpadLoadSchema>;

/**
 * Create the scratchpad_load tool definition.
 */
export function createScratchpadLoadToolDefinition(
	scratchpad: ScratchpadManager,
): ToolDefinition<typeof scratchpadLoadSchema> {
	return {
		name: "scratchpad_load",
		label: "Load from Scratchpad",
		description:
			"Load or search artifacts from the session scratchpad. " +
			"Can filter by category, tags, or search query. Returns artifact titles, paths, and content previews.",
		promptSnippet: "Load or search artifacts from the scratchpad",
		promptGuidelines: [
			"Use scratchpad_load to retrieve previously saved designs, plans, reports, results, thoughts, or processes.",
		],
		parameters: scratchpadLoadSchema,
		execute: async (
			_toolCallId: string,
			params: Static<typeof scratchpadLoadSchema>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> => {
			try {
				const limit = params.limit ?? 10;
				let entries: ReturnType<typeof scratchpad.list>;

				if (params.query) {
					entries = scratchpad.search(params.query, params.category as ScratchpadCategory | undefined);
				} else {
					entries = scratchpad.list(params.category as ScratchpadCategory | undefined, params.tags);
				}

				entries = entries.slice(0, limit);

				if (entries.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No artifacts found matching the criteria." }],
						details: { count: 0 },
					};
				}

				const formatted = entries
					.map((entry, i) => {
						const preview = entry.content.slice(0, 200).replace(/\n/g, " ");
						return `${i + 1}. [${entry.metadata.category}] ${entry.metadata.title}\n   Path: ${entry.path}\n   Preview: ${preview}${entry.content.length > 200 ? "..." : ""}`;
					})
					.join("\n\n");

				return {
					content: [{ type: "text" as const, text: `Found ${entries.length} artifact(s):\n\n${formatted}` }],
					details: {
						count: entries.length,
						entries: entries.map((e) => ({
							path: e.path,
							title: e.metadata.title,
							category: e.metadata.category,
						})),
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to load artifacts: ${message}` }],
					details: { error: message },
				};
			}
		},
	};
}
