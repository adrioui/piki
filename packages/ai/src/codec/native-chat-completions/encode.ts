/**
 * Native chat completions encoder.
 */

import { JSONSchema, type Schema } from "effect";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "../../prompt/messages.ts";
import type { ImagePart, TextPart, ToolCallPart } from "../../prompt/parts.ts";
import type { Prompt } from "../../prompt/prompt.ts";

function encodeImageUrl(data: string, mediaType: string): string {
	return `data:${mediaType};base64,${data}`;
}

function encodeUserContent(message: UserMessage): string | unknown[] {
	if (message.parts.every((part) => part._tag === "TextPart")) {
		return message.parts.map((part) => (part as TextPart).text).join("\n");
	}
	return message.parts.map((part) =>
		part._tag === "TextPart"
			? { type: "text", text: (part as TextPart).text }
			: {
					type: "image_url",
					image_url: { url: encodeImageUrl((part as ImagePart).data, (part as ImagePart).mediaType) },
				},
	);
}

function encodeAssistantToolCall(toolCall: ToolCallPart) {
	return {
		id: toolCall.providerToolCallId,
		type: "function",
		function: {
			name: toolCall.name,
			arguments: JSON.stringify(toolCall.input),
		},
	};
}

function encodeAssistantMessage(message: AssistantMessage) {
	const content = message.text ?? null;
	const reasoningContent = message.reasoning ?? null;
	const toolCalls = message.toolCalls?.map(encodeAssistantToolCall);
	return {
		role: "assistant",
		content,
		...(reasoningContent !== null ? { reasoning_content: reasoningContent } : {}),
		...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
	};
}

function encodeToolResultContent(message: ToolResultMessage): string | unknown[] {
	if (message.parts.every((part) => part._tag === "TextPart")) {
		return message.parts.map((part) => (part as TextPart).text).join("\n");
	}
	return message.parts.map((part) =>
		part._tag === "TextPart"
			? { type: "text", text: (part as TextPart).text }
			: {
					type: "image_url",
					image_url: { url: encodeImageUrl((part as ImagePart).data, (part as ImagePart).mediaType) },
				},
	);
}

function encodeMessage(message: Message) {
	switch (message._tag) {
		case "UserMessage":
			return {
				role: "user",
				content: encodeUserContent(message),
			};
		case "AssistantMessage":
			return encodeAssistantMessage(message);
		case "ToolResultMessage":
			return {
				role: "tool",
				tool_call_id: message.providerToolCallId,
				content: encodeToolResultContent(message),
			};
		default:
			throw new Error(`Unknown message tag: ${(message as { _tag: string })._tag}`);
	}
}

function toToolJsonSchema(node: unknown): unknown {
	if (node === null || node === undefined) return node;
	if (Array.isArray(node)) return node.map(toToolJsonSchema);
	if (typeof node !== "object") return node;
	const obj = node as Record<string, unknown>;
	const keys = Object.keys(obj);
	const isPlaceholder = keys.every((k) => k === "$id" || k === "title" || k === "$schema");
	if (isPlaceholder) return {};
	const result: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (k === "$id" || k === "$schema") continue;
		result[k] = typeof v === "object" ? toToolJsonSchema(v) : v;
	}
	return result;
}

function schemaToJsonSchema(schema: Schema.Schema<unknown>): unknown {
	return toToolJsonSchema(JSONSchema.make(schema));
}

function encodeTool(tool: { name: string; description: string; inputSchema: Schema.Schema<unknown> }) {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: schemaToJsonSchema(tool.inputSchema),
		},
	};
}

export function encodePrompt(
	model: string,
	prompt: Prompt,
	tools: Array<{ name: string; description: string; inputSchema: Schema.Schema<unknown> }>,
) {
	const messages: unknown[] = [];
	if (prompt.system.length > 0) {
		messages.push({ role: "system", content: prompt.system });
	}
	for (const message of prompt.messages) {
		messages.push(encodeMessage(message));
	}
	const encodedTools = tools.map(encodeTool);
	return {
		model,
		messages,
		...(encodedTools.length > 0 ? { tools: encodedTools } : {}),
	};
}
