/**
 * Prompt class.
 */

import { Schema } from "effect";
import { type Message, MessageSchema } from "./messages.ts";

export class Prompt extends Schema.Class<Prompt>("Prompt")({
	system: Schema.String,
	messages: Schema.Array(MessageSchema),
}) {
	static from(args: { system?: string; messages: Message[] }): Prompt {
		return Prompt.make({
			system: args.system ?? "",
			messages: [...args.messages],
		});
	}
}

export type { Message } from "./messages.ts";
