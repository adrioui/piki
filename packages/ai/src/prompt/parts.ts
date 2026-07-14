/**
 * Prompt part schemas.
 */

import { Schema } from "effect";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const JsonValueSchema: Schema.Schema<JsonValue> = Schema.suspend(
	(): Schema.Schema<JsonValue> =>
		Schema.Union(
			Schema.String,
			Schema.Number,
			Schema.Boolean,
			Schema.Null,
			Schema.Array(JsonValueSchema),
			Schema.Record({ key: Schema.String, value: JsonValueSchema }),
		),
);

export const TextPartSchema = Schema.TaggedStruct("TextPart", {
	text: Schema.String,
});

export const ImagePartSchema = Schema.TaggedStruct("ImagePart", {
	data: Schema.String,
	mediaType: Schema.Literal("image/png", "image/jpeg", "image/webp", "image/gif"),
	dimensions: Schema.optionalWith(
		Schema.Struct({
			width: Schema.Number,
			height: Schema.Number,
		}),
		{ exact: true },
	),
});

export const ToolCallPartSchema = Schema.TaggedStruct("ToolCallPart", {
	id: Schema.String,
	providerToolCallId: Schema.String,
	name: Schema.String,
	input: JsonValueSchema,
});

export type TextPart = Schema.Schema.Type<typeof TextPartSchema>;
export type ImagePart = Schema.Schema.Type<typeof ImagePartSchema>;
export type ToolCallPart = Schema.Schema.Type<typeof ToolCallPartSchema>;
