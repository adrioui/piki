/**
 * Subagent runtime - runs a subagent with its own model, tools, and error guard.
 */

import type { AssistantMessage, Context, Message, Model, TextContent } from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { TSchema } from "typebox";
import { ErrorRepeatGuard } from "../error-repeat-guard.ts";

export interface SubagentTool {
	name: string;
	parameters: TSchema;
	execute: (id: string, args: unknown, signal: AbortSignal | undefined) => Promise<unknown>;
}

export interface SubagentConfig {
	model: Model<string>;
	systemPrompt: string;
	userMessage: string;
	allowedTools: string[];
	tools: SubagentTool[];
	maxTurns?: number;
	sameErrorThreshold?: number;
}

export interface SubagentResult {
	text: string;
	turns: number;
	error?: string;
}

function isToolCallContent(
	content: unknown,
): content is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } {
	if (!content || typeof content !== "object") return false;
	const c = content as Record<string, unknown>;
	return c.type === "toolCall" && typeof c.id === "string" && typeof c.name === "string";
}

/**
 * Run a subagent with the given configuration.
 *
 * 1. Builds a conversation from system prompt and user message.
 * 2. Filters tools to only those in allowedTools.
 * 3. Loops up to maxTurns, calling streamSimple and executing tool calls.
 * 4. Returns the final assistant text and turn count.
 */
export async function runSubagent(config: SubagentConfig, signal?: AbortSignal): Promise<SubagentResult> {
	const { model, systemPrompt, userMessage, allowedTools, tools, maxTurns = 10, sameErrorThreshold = 3 } = config;

	const conversation: Message[] = [{ role: "user", content: userMessage, timestamp: Date.now() } as Message];

	const filteredTools = tools.filter((t) => allowedTools.includes(t.name));
	const errorGuard = new ErrorRepeatGuard({ threshold: sameErrorThreshold });

	for (let turn = 0; turn < maxTurns; turn++) {
		if (signal?.aborted) {
			return { text: "", turns: turn, error: "Subagent was aborted" };
		}

		const context: Context = {
			systemPrompt,
			messages: conversation,
			tools: filteredTools.map((t) => ({
				name: t.name,
				description: "",
				parameters: t.parameters,
			})),
		};

		let assistantMessage: AssistantMessage | undefined;

		try {
			const stream = streamSimple(model, context, { signal });
			assistantMessage = await stream.result();
		} catch (err) {
			return {
				text: "",
				turns: turn + 1,
				error: `Subagent LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		if (!assistantMessage) {
			return { text: "", turns: turn + 1, error: "Subagent received no response" };
		}

		// Collect text content from assistant message
		const textParts: string[] = [];
		const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

		for (const content of assistantMessage.content) {
			if (content.type === "text") {
				textParts.push((content as TextContent).text);
			} else if (isToolCallContent(content)) {
				toolCalls.push({ id: content.id, name: content.name, args: content.arguments });
			}
		}

		// Append assistant message to conversation
		conversation.push(assistantMessage as Message);

		// If no tool calls, return the text
		if (toolCalls.length === 0) {
			const resultText = textParts.join("\n");
			return { text: resultText, turns: turn + 1 };
		}

		// Execute tool calls
		for (const toolCall of toolCalls) {
			const tool = tools.find((t) => t.name === toolCall.name);
			if (!tool || !allowedTools.includes(toolCall.name)) {
				conversation.push({
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: `Error: Tool "${toolCall.name}" is not available to subagent` }],
					isError: true,
					timestamp: Date.now(),
				} as Message);
				continue;
			}

			let result: unknown;
			let isError = false;
			try {
				result = await tool.execute(toolCall.id, toolCall.args, signal);
			} catch (err) {
				result = `Error: ${err instanceof Error ? err.message : String(err)}`;
				isError = true;
			}

			// Check for repeated errors
			if (isError && typeof result === "string") {
				const guardResult = errorGuard.recordError(toolCall.name, toolCall.args, result);
				if (guardResult.shouldStop) {
					conversation.push({
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						content: [
							{
								type: "text",
								text:
									`[${toolCall.name}] The same tool call has failed ${guardResult.repeatCount} times with the same error.\n` +
									"Stop retrying the identical call. Change approach, inspect related context, or ask the user if blocked.",
							},
						],
						isError: true,
						timestamp: Date.now(),
					} as Message);
					return { text: "", turns: turn + 1, error: "Subagent exceeded same-error threshold" };
				}
			}

			const resultText = typeof result === "string" ? result : JSON.stringify(result, null, 2);
			conversation.push({
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: resultText }],
				isError,
				timestamp: Date.now(),
			} as Message);
		}
	}

	return { text: "", turns: maxTurns, error: "Subagent exceeded max turns" };
}
