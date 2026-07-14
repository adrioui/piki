// packages/agent/src/workers/chat-title.ts
//
// ChatTitleWorker generates a short chat title from the first resolved user
// message, implemented idiomatically on Effect. Branding stays "piki".
//
// Behavior:
// - subscribes to `UserMessageResolution/userMessageResolved`
// - skips forked or synthetic resolutions and already-titled chats
// - reads `ChatTitleProjection` (via the worker `read` fn) to avoid double
// titles, and extracts text from the resolved content to skip empties
// - then delegates to `ChatTitleServiceTag.generate(text)` and persists the
// title via `ChatTitleProjection` + a `chat_title_generated` event
//
// The actual title generation / persistence fan-out is NOT yet wired into
// `packages/agent` (the dependencies are documented in the BLOCKED marker
// below). What is fillable with the currently-available primitives is filled
// here; the remainder is explicitly blocked rather than faked.

import { defineWorker as define, type WorkerReadFn } from "@piki/event-core";
import { Logger } from "@piki/logger";
import { Cause, Effect } from "effect";
import { ChatTitleProjection } from "../projections/chat-title.ts";
import { UserMessageResolutionProjection } from "../projections/user-message-resolution.ts";

interface ChatTitleInput {
	readonly forkId: string | null;
	readonly synthetic: boolean;
	readonly messageId: string;
	readonly content: unknown;
}

// Local helper that pulls a flat string out of the resolved message content
// (string or TextPart array). `turn.ts` has the same helper but does not export
// it, so we keep a tiny local copy rather than modify that file.
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part !== null && typeof part === "object" && (part as { _tag?: string })._tag === "TextPart")
			.map((part) => (part as { text?: string }).text ?? "")
			.join("");
	}
	if (content !== null && typeof content === "object" && "text" in content) {
		return String((content as { text: unknown }).text);
	}
	return "";
}

const generateTitle = Effect.fn("ChatTitleWorker.generateTitle")(function* (input: ChatTitleInput, read: WorkerReadFn) {
	const logger = yield* Logger;
	const scoped = yield* logger.namespace("ChatTitleWorker");
	yield* scoped.log("info", {
		message: "[chat-title-worker] Signal received",
		forkId: input.forkId,
		synthetic: input.synthetic,
	});

	if (input.forkId !== null || input.synthetic) {
		yield* scoped.log("info", {
			message: "[chat-title-worker] Skipping: forked or synthetic",
		});
		return;
	}

	// Skip already-titled chats by reading the (non-forked) ChatTitleProjection.
	const titleState = yield* read(ChatTitleProjection);
	if (titleState?.chatName != null) {
		yield* scoped.log("info", {
			message: "[chat-title-worker] Skipping: chat already titled",
		});
		return;
	}

	// Extract and guard against empty content.
	const text = extractText(input.content).replace(/\s+/g, " ").trim();
	if (text.length === 0) {
		yield* scoped.log("info", {
			message: "[chat-title-worker] Skipping: empty resolved content",
		});
		return;
	}

	// BLOCKED: the title generation + persistence fan-out
	// depends on subsystems not yet wired into packages/agent:
	// - ChatTitleServiceTag.generate(text) (does not exist)
	// - real ChatPersistence.getSessionMetadata / saveSessionMetadata
	// (only ChatPersistenceNoop exists)
	// - updateTraceMeta (does not exist)
	// - AgentModelOperationContextTag (exists only in packages/coding-agent)
	// Once these land (a future milestone), delegate generation here and
	// publish { type: "chat_title_generated", forkId: null, title, timestamp }.
	yield* scoped.log("info", {
		message: "[chat-title-worker] Title generation deferred: dependency surface not yet wired",
		messageId: input.messageId,
		preview: text.slice(0, 120),
	});
});

export const ChatTitleWorker = define()({
	name: "ChatTitleWorker",
	signalHandlers: (on) => [
		on(UserMessageResolutionProjection.signals.userMessageResolved, (value, _publish, read) =>
			generateTitle(
				{
					forkId: value.forkId,
					synthetic: value.synthetic,
					messageId: value.messageId,
					content: value.content,
				},
				read,
			).pipe(
				Effect.catchAllCause((cause) =>
					Effect.gen(function* () {
						const logger = yield* Logger;
						const scoped = yield* logger.namespace("ChatTitleWorker");
						yield* scoped.log("error", {
							message: "[chat-title-worker] Title generation side effect failed",
							cause: Cause.pretty(cause),
						});
					}),
				),
			),
		),
	],
});
