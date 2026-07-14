import { Schema } from "effect";

/** Schema for an image returned by image-capable tools. */
export const ToolImageSchema = Schema.Struct({
	base64: Schema.String,
	mediaType: Schema.Literal("image/png", "image/jpeg", "image/webp", "image/gif"),
	width: Schema.Number,
	height: Schema.Number,
}).annotations({ identifier: "ToolImage" });

export type ToolImage = Schema.Schema.Type<typeof ToolImageSchema>;
