/**
 * NativeChatCompletions protocol — model factory + options.
 */

import { Data, Effect, Schema } from "effect";
import { modelDefine } from "../../model/define.ts";
import { applyOptionDefs, Option3, type OptionDef } from "../../options/option.ts";
import { ChatCompletionsStreamChunk } from "../../wire/chat-completions.ts";
import { nativeChatCompletionsCodec } from "./index.ts";

export const options: Record<string, OptionDef<unknown, unknown>> = {
	maxTokens: Option3.define((v: number) => ({ max_tokens: v })),
	temperature: Option3.define((v: number) => ({ temperature: v })),
	stop: Option3.define((v: string[]) => ({ stop: [...v] })),
	topP: Option3.define((v: number) => ({ top_p: v })),
	toolChoice: Option3.define((v: string) => ({ tool_choice: v })),
};

export class ChatPayloadJsonParseError extends Data.TaggedError("ChatPayloadJsonParseError")<{
	message: string;
	raw: string;
	cause: unknown;
}> {}

export class ChatPayloadSchemaDecodeError extends Data.TaggedError("ChatPayloadSchemaDecodeError")<{
	message: string;
	raw: string;
	cause: unknown;
}> {}

export const decodeChatCompletionsPayload = (raw: string) =>
	Effect.flatMap(
		Effect.try({
			try: () => JSON.parse(raw),
			catch: (cause) =>
				new ChatPayloadJsonParseError({
					message: `Invalid JSON: ${raw} (${String(cause)})`,
					raw,
					cause,
				}),
		}),
		(parsed) =>
			Effect.mapError(
				Schema.decodeUnknown(ChatCompletionsStreamChunk)(parsed),
				(cause) =>
					new ChatPayloadSchemaDecodeError({
						message: `Chunk decode failed: ${String(cause)}`,
						raw,
						cause,
					}),
			),
	);

export const NativeChatCompletions = {
	model,
	options,
};

function model(config: {
	modelId: string;
	endpoint: string;
	capabilities?: { vision?: boolean; grammar?: boolean };
	classifyRejectedResponse?: unknown;
	compose?: (wire: Record<string, unknown>, callOptions: Record<string, unknown>) => Record<string, unknown>;
}) {
	return modelDefine({
		modelId: config.modelId,
		endpoint: config.endpoint,
		path: "/chat/completions",
		codec: { decode: nativeChatCompletionsCodec.decode },
		doneSignal: "[DONE]",
		decodePayload: decodeChatCompletionsPayload,
		classifyRejectedResponse: config.classifyRejectedResponse,
		capabilities: config.capabilities,
		buildWireRequest: (prompt: unknown, tools: unknown, callOptions: Record<string, unknown>) => {
			const optionFragments = applyOptionDefs(options, callOptions as Record<string, unknown>);
			const promptFragment = nativeChatCompletionsCodec.encodePrompt(
				config.modelId,
				prompt as never,
				tools as never,
			);
			let wire: Record<string, unknown> = {
				stream: true,
				stream_options: { include_usage: true },
				...optionFragments,
				...promptFragment,
			};
			if (wire.tools && (wire.tools as unknown[]).length > 0 && !wire.tool_choice) {
				wire = { ...wire, tool_choice: "auto" };
			}
			if (config.compose) {
				wire = config.compose(wire, callOptions as Record<string, unknown>);
			}
			return wire;
		},
	} as never);
}
