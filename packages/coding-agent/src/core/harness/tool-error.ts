import { Schema } from "effect";

/**
 * Factory for a tool error schema with a tagged _tag and message.
 */
export function ToolErrorSchema<const Tag extends string, const F extends Record<string, Schema.Schema<unknown>>>(
	tag: Tag,
	fields: F,
): Schema.Schema<{ _tag: Tag; message: string } & { [K in keyof F]: Schema.Schema.Type<F[K]> }> {
	return Schema.Struct({
		_tag: Schema.Literal(tag),
		message: Schema.String,
		...fields,
	}) as unknown as Schema.Schema<{ _tag: Tag; message: string } & { [K in keyof F]: Schema.Schema.Type<F[K]> }>;
}
