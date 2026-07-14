import type { AgentTool } from "@piki/agent-core";
import { Effect } from "effect";
import { type Static, Type } from "typebox";
import {
	type CompactionContext,
	type CompactionResult,
	type SubmittedCompactionResult,
	submitCompactionResult,
} from "../compaction/index.ts";
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
	getCompactionContext?: () => CompactionContext | undefined;
}

export interface ManualCompactToolDetails {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
}

export interface SubmittedCompactToolDetails extends SubmittedCompactionResult {
	status: "ok";
	filesRead: number;
}

export type CompactToolDetails = ManualCompactToolDetails | SubmittedCompactToolDetails;

function compactSummary(result: CompactionResult): ManualCompactToolDetails {
	return {
		summary: result.summary,
		firstKeptEntryId: result.firstKeptEntryId,
		tokensBefore: result.tokensBefore,
		estimatedTokensAfter: result.estimatedTokensAfter,
	};
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

async function submitContextCompaction(
	context: CompactionContext,
	params: CompactInput,
): Promise<SubmittedCompactToolDetails> {
	if (!context.isCompacting) {
		throw new Error("compact tool can only submit summaries during an active compaction lifecycle");
	}
	if (typeof params.summary !== "string" || typeof params.reflection !== "string") {
		throw new Error("compact tool requires summary and reflection during compaction lifecycle");
	}
	const files = params.files ?? [];
	if (files.length > 10) {
		throw new Error("compact tool accepts at most 10 files");
	}
	const budgetUsed = estimateTokens(`${params.summary}\n${params.reflection}\n${files.join("\n")}`);
	if (budgetUsed > context.maxPayloadTokens) {
		throw new Error(`compact payload exceeds budget: ${budgetUsed}/${context.maxPayloadTokens} tokens`);
	}
	const submitted: SubmittedCompactionResult = {
		summary: params.summary,
		reflection: params.reflection,
		files,
		budgetUsed,
		budgetTotal: context.maxPayloadTokens,
	};
	await Effect.runPromise(submitCompactionResult(context, submitted));
	return { ...submitted, status: "ok", filesRead: files.length };
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
		async execute(_toolCallId, params: CompactInput) {
			const context = options.getCompactionContext?.();
			if (context && (params.summary !== undefined || params.reflection !== undefined)) {
				const details = await submitContextCompaction(context, params);
				return {
					content: [
						{
							type: "text",
							text: `Compaction submitted. Files read: ${details.filesRead}. Budget: ${details.budgetUsed}/${details.budgetTotal}.`,
						},
					],
					details,
				};
			}
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
