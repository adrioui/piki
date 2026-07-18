import type { AgentTool } from "@piki/agent-core";
import { type Static, Type } from "typebox";
import type { CompactionResult } from "../compaction/index.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const compactSchema = Type.Object({
	summary: Type.String({
		description:
			"What happened: decisions made, work completed, current state, user instructions and preferences, work in progress. Be specific: file paths, function names, error messages, architectural decisions, user requirements. Enough for your future self to continue without re-reading the conversation.",
	}),
	reflection: Type.String({
		description:
			"What went wrong, incorrect assumptions, approaches that failed, what to do differently. Not what happened — what your future self should change. Name the reasoning traps so your future self avoids them.",
	}),
	files: Type.Optional(
		Type.Array(
			Type.String({
				description:
					"File paths to read and preserve verbatim in future context. Use for source code being actively edited, configs, or content that cannot survive summarization. Max 10 files.",
			}),
		),
	),
});

export type CompactInput = Static<typeof compactSchema>;

export interface CompactToolOptions {
	runCompact?: (customInstructions?: string) => Promise<CompactionResult>;
}

export interface ManualCompactToolDetails {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
}

export type CompactToolDetails = ManualCompactToolDetails;

function compactSummary(result: CompactionResult): ManualCompactToolDetails {
	return {
		summary: result.summary,
		firstKeptEntryId: result.firstKeptEntryId,
		tokensBefore: result.tokensBefore,
		estimatedTokensAfter: result.estimatedTokensAfter,
	};
}

export function createCompactToolDefinition(
	options: CompactToolOptions = {},
): ToolDefinition<typeof compactSchema, CompactToolDetails> {
	return {
		name: "compact",
		label: "Compact",
		description:
			"System tool for context compaction. Do not call directly — the system will instruct you when to use it.",
		hidden: true,
		parameters: compactSchema,
		async execute(_toolCallId, _params: CompactInput) {
			if (!options.runCompact) {
				throw new Error("compact tool is not connected to a session compaction runner");
			}
			const result = await options.runCompact();
			const details = compactSummary(result);
			return {
				content: [{ type: "text", text: `Compacted context.\n\n${result.summary}` }],
				details,
			};
		},
	};
}

export function createCompactTool(
	options: CompactToolOptions = {},
): AgentTool<typeof compactSchema, CompactToolDetails> {
	return wrapToolDefinition(createCompactToolDefinition(options));
}
