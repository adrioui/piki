/**
 * Vision normalization for non-multimodal models.
 */

import type { Message, ToolResultMessage, UserMessage } from "./messages.ts";
import type { ImagePart, TextPart } from "./parts.ts";
import { Prompt } from "./prompt.ts";

export function imagePlaceholder(part: ImagePart): string {
	const segments = ["Image placeholder: current model does not support images"];
	const meta: string[] = [];
	if (part.dimensions) {
		meta.push(`${part.dimensions.width}x${part.dimensions.height}`);
	} else if (part.mediaType) {
		meta.push(part.mediaType);
	}
	if (meta.length > 0) {
		segments.push("\u2014", meta.join(" "));
	}
	return `[${segments.join(" ")}]`;
}

export function normalizePartsVision(
	parts: readonly (TextPart | ImagePart)[],
	format: (part: ImagePart) => string,
): readonly (TextPart | ImagePart)[] {
	let changed = false;
	const result = parts.map((part) => {
		if (part._tag === "ImagePart") {
			changed = true;
			return { _tag: "TextPart", text: format(part) } as TextPart;
		}
		return part;
	});
	return changed ? result : parts;
}

export function normalizeVision(prompt: Prompt, format: (part: ImagePart) => string = imagePlaceholder): Prompt {
	let changed = false;
	const messages = prompt.messages.map((msg) => {
		switch (msg._tag) {
			case "UserMessage": {
				const parts = normalizePartsVision(msg.parts, format);
				if (parts !== msg.parts) {
					changed = true;
					return { ...msg, parts } as UserMessage;
				}
				return msg;
			}
			case "ToolResultMessage": {
				const parts = normalizePartsVision(msg.parts, format);
				if (parts !== msg.parts) {
					changed = true;
					return { ...msg, parts } as ToolResultMessage;
				}
				return msg;
			}
			case "AssistantMessage":
				return msg;
			default:
				return msg;
		}
	});
	if (!changed) return prompt;
	return Prompt.from({ system: prompt.system, messages: messages as Message[] });
}
