// packages/agent/src/projections/user-message-resolution.ts
//
// UserMessageResolutionProjection buffers raw user messages and emits a
// `userMessageResolved` signal once the message is marked ready (mentions
// resolved).

import { defineProjection, type EffectProjectionDefinition } from "@piki/event-core";

export interface RawUserMessage {
	readonly messageId: string;
	readonly forkId: string | null;
	readonly timestamp: number;
	readonly content: unknown;
	readonly attachments: unknown;
	readonly mode: unknown;
	readonly synthetic: boolean;
	readonly taskMode: unknown;
}

export interface UserMessageResolutionState {
	readonly rawByMessageId: Map<string, RawUserMessage>;
}

export const UserMessageResolutionProjection: EffectProjectionDefinition<UserMessageResolutionState> =
	defineProjection()<UserMessageResolutionState>({
		name: "UserMessageResolution",
		initial: {
			rawByMessageId: new Map(),
		},
		signals: {
			userMessageResolved: { name: "UserMessageResolution/userMessageResolved" },
		},
		eventHandlers: {
			user_message: ({ event, state }) => ({
				...state,
				rawByMessageId: new Map(state.rawByMessageId).set(event.messageId, {
					messageId: event.messageId,
					forkId: event.forkId,
					timestamp: event.timestamp,
					content: event.content,
					attachments: event.attachments,
					mode: event.mode,
					synthetic: event.synthetic,
					taskMode: event.taskMode,
				}),
			}),
			user_message_ready: ({ event, state, emit }) => {
				const raw = state.rawByMessageId.get(event.messageId);
				if (!raw) {
					return state;
				}
				emit.userMessageResolved({
					messageId: raw.messageId,
					forkId: raw.forkId,
					content: raw.content,
					attachments: raw.attachments,
					mode: raw.mode,
					synthetic: raw.synthetic,
					taskMode: raw.taskMode,
					resolvedMentions: event.resolvedMentions,
				});
				const next = new Map(state.rawByMessageId);
				next.delete(event.messageId);
				return { ...state, rawByMessageId: next };
			},
		},
	});
