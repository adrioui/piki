// packages/agent/src/projections/chat-title.ts
//
// ChatTitleProjection holds the generated chat title and emits a signal when a
// new title is produced by the ChatTitleWorker.

import { defineProjection, type EffectProjectionDefinition } from "@piki/event-core";

export interface ChatTitleState {
	readonly chatName: string | null;
}

export const ChatTitleProjection: EffectProjectionDefinition<ChatTitleState> = defineProjection()<ChatTitleState>({
	name: "ChatTitle",
	initial: {
		chatName: null,
	},
	signals: {
		chatTitleGenerated: { name: "ChatTitle/chatTitleGenerated" },
	},
	eventHandlers: {
		chat_title_generated: ({ event, state, emit }) => {
			emit.chatTitleGenerated({ title: event.title });
			return { ...state, chatName: event.title };
		},
	},
});
