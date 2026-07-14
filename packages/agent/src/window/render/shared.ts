/**
 * Shared window/render entry converters.
 *
 * Provides the small, reusable helpers that turn window message entries and
 * turn feedback into prompt `Message` / `ContentPart` fragments consumed by the
 * full timeline renderer (`window/render/full.ts`).
 *
 * These are pure synchronous functions. `Effect.fn` is intentionally not used:
 * these helpers do not produce `Effect<A, E, R>`.
 */

import type { Message, UserMessage } from "@piki/ai/prompt/messages";
import type { ContentPart } from "@piki/harness";
import type { AgentStatusLike, DetachedProcessStateLike, FeedbackEntry, TimelineEntry } from "./full.ts";
import { renderTimeline } from "./full.ts";

// ---------------------------------------------------------------------------
// System / context entry converters
// ---------------------------------------------------------------------------

/**
 * Convert a system-style window message (session context, fork context, goal
 * injection, compacted) into a single user message.
 */
export function systemEntryToMessages(entry: { content: ContentPart[] }): UserMessage[] {
	return [
		{
			_tag: "UserMessage",
			parts: entry.content as readonly ContentPart[],
		},
	];
}

/**
 * Convert a `context` window message (a timeline) into a single user message,
 * rendering the timeline via `renderTimeline` and dropping it when empty.
 */
export function contextEntryToMessages(
	entry: { timeline: TimelineEntry[] },
	timezone: string | undefined,
	agentStatus: AgentStatusLike | undefined,
	detachedProcessState: DetachedProcessStateLike | undefined,
	forkId: string | undefined,
): UserMessage[] {
	const parts = renderTimeline({
		timeline: entry.timeline,
		timezone,
		agentStatus,
		detachedProcessState,
		forkId,
	});
	const hasContent = parts.some((p) => {
		if (p._tag === "TextPart") return p.text.trim().length > 0;
		if (p._tag === "ImagePart") return true;
		return false;
	});
	if (!hasContent) return [];
	return [
		{
			_tag: "UserMessage",
			parts: parts as readonly ContentPart[],
		},
	];
}

// ---------------------------------------------------------------------------
// Feedback rendering
// ---------------------------------------------------------------------------

/**
 * Render turn feedback entries into a single newline-joined text fragment.
 */
export function renderFeedbackText(feedback: FeedbackEntry[]): string {
	const lines: string[] = [];
	for (const fb of feedback) {
		switch (fb.kind) {
			case "message_ack":
				lines.push(`<message-sent to="${fb.destination}" chars="${fb.chars}"/>`);
				break;
			case "error":
				lines.push(`<error>${fb.message}</error>`);
				break;
			case "overthinking":
				lines.push(`<overthinking>${fb.message}</overthinking>`);
				break;
			case "interrupted":
				lines.push("<interrupted>The user pressed ESC and has interrupted your turn.</interrupted>");
				break;
		}
	}
	return lines.join("\n");
}

/**
 * Render turn feedback entries into a `ContentPart[]`, dropping empty feedback.
 */
export function renderFeedback(feedback: FeedbackEntry[]): ContentPart[] {
	const text = renderFeedbackText(feedback);
	if (!text) return [];
	return [{ _tag: "TextPart", text }];
}

// ---------------------------------------------------------------------------
// Terminal user message normalization
// ---------------------------------------------------------------------------

/**
 * Ensure the final message list ends with a user message, pushing a placeholder
 * user message when the last message is an assistant turn or the list is empty.
 */
export function ensureTerminalUserMessage(messages: Message[], placeholder = "(continue)"): Message[] {
	const result = [...messages];
	const last = result[result.length - 1];
	if (!last || last._tag === "AssistantMessage") {
		result.push({
			_tag: "UserMessage",
			parts: [{ _tag: "TextPart", text: placeholder }],
		});
	}
	return result;
}
