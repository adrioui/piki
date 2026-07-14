/**
 * Prompt message schemas.
 */

import { Schema } from "effect";
import { ImagePartSchema, TextPartSchema, ToolCallPartSchema } from "./parts.ts";

export const UserPartSchema = Schema.Union(TextPartSchema, ImagePartSchema);

export const UserMessageSchema = Schema.TaggedStruct("UserMessage", {
	parts: Schema.Array(UserPartSchema),
});

export const AssistantMessageSchema = Schema.TaggedStruct("AssistantMessage", {
	reasoning: Schema.optional(Schema.String),
	text: Schema.optional(Schema.String),
	toolCalls: Schema.optional(Schema.Array(ToolCallPartSchema)),
});

export const ToolResultMessageSchema = Schema.TaggedStruct("ToolResultMessage", {
	toolCallId: Schema.String,
	providerToolCallId: Schema.String,
	toolName: Schema.String,
	parts: Schema.Array(UserPartSchema),
});

export const MessageSchema = Schema.Union(UserMessageSchema, AssistantMessageSchema, ToolResultMessageSchema);

export type UserMessage = Schema.Schema.Type<typeof UserMessageSchema>;
export type AssistantMessage = Schema.Schema.Type<typeof AssistantMessageSchema>;
export type ToolResultMessage = Schema.Schema.Type<typeof ToolResultMessageSchema>;
export type Message = Schema.Schema.Type<typeof MessageSchema>;
