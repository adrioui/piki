/**
 * User message parts renderer.
 *
 * Renders a timeline `user_message` entry (with attachments / mentions) into a
 * list of `ContentPart` via the harness `ContentBuilder`. Pure synchronous
 * function; no `Effect.fn`.
 */

import { ContentBuilder, type ContentPart } from "@piki/harness";
import type { TimelineAttachment, TimelineEntry } from "./full.ts";

/** Options controlling the message wrapper and attachment placement. */
export interface UserMessagePartOptions {
	/** Opening wrapper text (e.g. `<message from="user">`). */
	open: string;
	/** Closing wrapper text (e.g. `</message>`). */
	close: string;
	/**
	 * When `true`, the opening wrapper and `entry2.text` are emitted before
	 * attachments, and `close` is emitted after them. When `false`, the wrapper
	 * surrounds `entry2.text` immediately and attachments follow.
	 */
	attachmentsInsideWrapper: boolean;
}

/** Default rendering options: text wrapped in `<message from="user">...</message>`. */
export const defaultUserMessageOptions: UserMessagePartOptions = {
	open: '<message from="user">',
	close: "</message>",
	attachmentsInsideWrapper: false,
};

/**
 * Render a `user_message` timeline entry into `ContentPart[]`, expanding image
 * attachments, error mentions, and file mentions with optional truncation /
 * byte / line-range metadata.
 */
export function renderTimelineUserMessageParts(
	entry: Extract<TimelineEntry, { kind: "user_message" }>,
	options: UserMessagePartOptions = defaultUserMessageOptions,
): ContentPart[] {
	const builder = new ContentBuilder();
	const attachmentsInsideWrapper = options.attachmentsInsideWrapper === true;
	builder.pushText(
		attachmentsInsideWrapper ? `${options.open}${entry.text}` : `${options.open}${entry.text}${options.close}`,
	);
	for (const attachment of entry.attachments as TimelineAttachment[]) {
		if (attachment.kind === "image") {
			if (attachment.description) {
				builder.pushText(`\n[User uploaded an image. Description: ${attachment.description}]`);
			} else if (attachment.image) {
				builder.pushPart(attachment.image);
			}
			continue;
		}
		if (attachment.error) {
			builder.pushText(
				`\n<mention path="${attachment.path}" type="${attachment.contentType}" error="${attachment.error}"/>`,
			);
			continue;
		}
		const truncated = attachment.truncated ? ' truncated="true"' : "";
		const originalBytes = attachment.originalBytes ? ` original_bytes="${attachment.originalBytes}"` : "";
		const lines = attachment.lineRange ? ` lines="${attachment.lineRange.start}-${attachment.lineRange.end}"` : "";
		builder.pushText(
			`\n<mention path="${attachment.path}" type="${attachment.contentType}"${truncated}${originalBytes}${lines}>${attachment.content ?? ""}</mention>`,
		);
	}
	if (attachmentsInsideWrapper) {
		builder.pushText(options.close);
	}
	return builder.build();
}
