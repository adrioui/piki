/**
 * oracle tool - Ask the oracle subagent for expert technical guidance.
 *
 * The oracle is a read-only expert advisor (code review, architecture,
 * strategy). It runs in an isolated context and only its final answer is
 * returned to the calling agent. It never edits or writes files.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { getSubagentSpec } from "../subagent/registry.ts";
import { runSubagent, type SubagentTool } from "../subagent/runtime.ts";

const oracleSchema = Type.Object({
	request: Type.String({
		description:
			"A focused question or request for expert guidance: code review, architecture advice, design trade-offs, or strategic planning. Include enough context for the oracle to investigate without seeing this conversation.",
	}),
});

export type OracleInput = Static<typeof oracleSchema>;

export interface CreateOracleToolDefinitionOptions {
	cwd: string;
	model: Model<string> | (() => Model<string> | undefined);
	tools: SubagentTool[];
	maxTurns?: number;
}

/**
 * Create the oracle tool definition.
 *
 * Requires a model reference (or factory) and the available subagent-accessible
 * read-only tools. The oracle spec enforces a read-only tool set; passing
 * edit/write tools here does not expose them because the spec filters them out.
 */
export function createOracleToolDefinition(
	options: CreateOracleToolDefinitionOptions,
): ToolDefinition<typeof oracleSchema> {
	const maxTurns = options.maxTurns ?? 10;
	return {
		name: "oracle",
		label: "Oracle",
		description:
			"Ask the oracle subagent for expert, read-only technical guidance: code review, architecture advice, design trade-offs, or strategic planning. It inspects the codebase with read-only tools and returns a concise recommendation. Use it when you want a second opinion or deeper analysis before acting.",
		promptSnippet: "Ask the oracle subagent for expert code/architecture advice",
		promptGuidelines: [
			"Use oracle for expert advice, code review, or architecture analysis you cannot resolve by reading alone; do not use it as a substitute for reading files yourself.",
			"Give oracle a focused, self-contained request. The oracle does not see this conversation, so include the relevant file paths, symbols, and the decision you need.",
			"oracle is read-only and returns only its final recommendation; treat the answer as advice, not as an executed change.",
		],
		parameters: oracleSchema,
		execute: async (
			_toolCallId: string,
			params: Static<typeof oracleSchema>,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> => {
			try {
				const spec = getSubagentSpec("oracle");
				if (!spec) {
					return {
						content: [{ type: "text" as const, text: "Error: oracle subagent spec not found" }],
						details: {},
					};
				}

				const resolvedModel = typeof options.model === "function" ? options.model() : options.model;
				if (!resolvedModel) {
					return {
						content: [{ type: "text" as const, text: "Error: no model available for oracle subagent" }],
						details: {},
					};
				}

				const result = await runSubagent(
					{
						model: resolvedModel,
						systemPrompt: spec.systemPrompt,
						userMessage: params.request,
						allowedTools: spec.allowedTools,
						tools: options.tools,
						maxTurns,
					},
					signal,
				);

				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Oracle subagent error: ${result.error}` }],
						details: { error: result.error, turns: result.turns },
					};
				}

				return {
					content: [{ type: "text" as const, text: result.text || "Oracle returned no answer." }],
					details: { turns: result.turns },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to run oracle subagent: ${message}` }],
					details: { error: message },
				};
			}
		},
	};
}
