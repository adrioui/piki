/**
 * Chat completions wire format schemas.
 */

import { Schema } from "effect";

export const ChatToolCallDelta = Schema.Struct({
	index: Schema.Number,
	id: Schema.optional(Schema.NullOr(Schema.String)),
	type: Schema.optional(Schema.NullOr(Schema.Literal("function"))),
	function: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				name: Schema.optional(Schema.NullOr(Schema.String)),
				arguments: Schema.optional(Schema.NullOr(Schema.String)),
			}),
		),
	),
});

export const ChatChunkDelta = Schema.Struct({
	role: Schema.optional(Schema.NullOr(Schema.String)),
	content: Schema.optional(Schema.NullOr(Schema.String)),
	reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
	tool_calls: Schema.optional(Schema.NullOr(Schema.Array(ChatToolCallDelta))),
});

export const ChatChunkLogprobs = Schema.Struct({
	content: Schema.optional(
		Schema.NullOr(
			Schema.Array(
				Schema.Struct({
					token: Schema.String,
					logprob: Schema.Number,
					top_logprobs: Schema.Array(
						Schema.Struct({
							token: Schema.String,
							logprob: Schema.Number,
						}),
					),
				}),
			),
		),
	),
});

export const ChatChunkChoice = Schema.Struct({
	index: Schema.Number,
	delta: ChatChunkDelta,
	finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
	logprobs: Schema.optional(Schema.NullOr(ChatChunkLogprobs)),
});

export const ChatChunkUsage = Schema.Struct({
	prompt_tokens: Schema.Number,
	completion_tokens: Schema.Number,
	prompt_tokens_details: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				cached_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
			}),
		),
	),
	cost: Schema.optional(Schema.Number),
});

export class ChatCompletionsStreamChunk extends Schema.Class<ChatCompletionsStreamChunk>("ChatCompletionsStreamChunk")({
	id: Schema.String,
	object: Schema.String,
	created: Schema.Number,
	model: Schema.String,
	choices: Schema.Array(ChatChunkChoice),
	usage: Schema.optional(Schema.NullOr(ChatChunkUsage)),
	raw_input: Schema.optional(
		Schema.Array(
			Schema.Struct({
				text: Schema.String,
				id: Schema.Number,
			}),
		),
	),
	raw_output: Schema.optional(
		Schema.Array(
			Schema.Struct({
				text: Schema.String,
				id: Schema.Number,
				logprobs: Schema.NullOr(
					Schema.Array(
						Schema.Struct({
							text: Schema.String,
							logprob: Schema.Number,
						}),
					),
				),
			}),
		),
	),
	error: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				message: Schema.String,
				type: Schema.optional(Schema.NullOr(Schema.String)),
				code: Schema.optional(Schema.NullOr(Schema.String)),
				param: Schema.optional(Schema.NullOr(Schema.String)),
			}),
		),
	),
}) {}
