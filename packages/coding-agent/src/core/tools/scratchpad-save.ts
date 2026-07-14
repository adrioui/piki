/**
 * scratchpad_save tool: Save an artifact to the session scratchpad.
 *
 * Provides durable artifact storage for designs, plans, reports, and results.
 */

import type { AgentToolResult } from "@piki/agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { ScratchpadArtifact, ScratchpadCategory, ScratchpadManager } from "../scratchpad-manager.ts";

const SCRATCHPAD_CATEGORIES: ScratchpadCategory[] = ["designs", "plans", "reports", "results", "thoughts", "processes"];

const SCRATCHPAD_CATEGORY_ALIASES: Record<string, ScratchpadCategory> = {
	analysis: "reports",
	analyses: "reports",
	audit: "reports",
	audits: "reports",
	critique: "reports",
	critiques: "reports",
	design: "designs",
	plan: "plans",
	process: "processes",
	report: "reports",
	result: "results",
	summary: "reports",
	summaries: "reports",
	thought: "thoughts",
	verification: "results",
	verifications: "results",
};

const SCRATCHPAD_CATEGORY_INPUTS = [...SCRATCHPAD_CATEGORIES, ...Object.keys(SCRATCHPAD_CATEGORY_ALIASES)] as const;

const scratchpadSaveSchema = Type.Object({
	title: Type.String({ description: "Title for the artifact" }),
	category: Type.Union(
		SCRATCHPAD_CATEGORY_INPUTS.map((c) => Type.Literal(c)),
		{ description: "Category directory for the artifact" },
	),
	content: Type.String({ description: "Full artifact content to save" }),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags for filtering" })),
});

export type ScratchpadSaveInput = Static<typeof scratchpadSaveSchema>;

/**
 * Create the scratchpad_save tool definition.
 */
export function createScratchpadSaveToolDefinition(
	scratchpad: ScratchpadManager,
): ToolDefinition<typeof scratchpadSaveSchema> {
	return {
		name: "scratchpad_save",
		label: "Save to Scratchpad",
		description:
			"Save an artifact (design, plan, report, result, thought, or process) to the session scratchpad. " +
			"Artifacts are stored as markdown files with YAML frontmatter and can be retrieved later.",
		promptSnippet: "Save an artifact to the session scratchpad",
		promptGuidelines: [
			"Use scratchpad_save to persist important intermediate artifacts like designs, plans, and analysis results.",
			"Artifacts are organized by category: designs, plans, reports, results, thoughts, processes.",
		],
		parameters: scratchpadSaveSchema,
		prepareArguments: (args: unknown) => normalizeScratchpadSaveArgs(args) as Static<typeof scratchpadSaveSchema>,
		execute: async (
			_toolCallId: string,
			params: Static<typeof scratchpadSaveSchema>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> => {
			try {
				const artifact: ScratchpadArtifact = {
					title: params.title,
					category: params.category as ScratchpadCategory,
					content: params.content,
					tags: params.tags,
				};
				const path = scratchpad.save(artifact);
				return {
					content: [
						{
							type: "text" as const,
							text: `Saved artifact "${params.title}" to ${params.category}: ${path}`,
						},
					],
					details: { path, category: params.category, title: params.title },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to save artifact: ${message}` }],
					details: { error: message },
				};
			}
		},
	};
}

function normalizeScratchpadSaveArgs(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const normalized = { ...(args as Record<string, unknown>) };
	if (typeof normalized.category === "string") {
		const key = normalized.category
			.trim()
			.toLowerCase()
			.replace(/[\s_-]+/g, "_");
		normalized.category = SCRATCHPAD_CATEGORY_ALIASES[key] ?? normalized.category;
	}
	return normalized;
}
