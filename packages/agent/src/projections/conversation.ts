// packages/agent/src/projections/conversation.ts
//
// ConversationProjection accumulates the lead/user conversation transcript from
// root-fork (forkId === null) message events and resolved user messages.

import { defineProjection, type EffectProjectionDefinition } from "@piki/event-core";
import { UserMessageResolutionProjection } from "./user-message-resolution.ts";

export type ConversationRole = "lead" | "user";

export interface ConversationEntry {
	readonly role: ConversationRole;
	readonly text: string;
}

export interface ConversationState {
	readonly entries: ReadonlyArray<ConversationEntry>;
	readonly pendingProse: string;
	readonly userMessageIds: Set<string>;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
			)
			.join("");
	}
	if (content && typeof content === "object" && "text" in content) return String((content as { text: unknown }).text);
	return "";
}

export const ConversationProjection: EffectProjectionDefinition<ConversationState> =
	defineProjection()<ConversationState>({
		name: "Conversation",
		reads: [UserMessageResolutionProjection],
		initial: {
			entries: [],
			pendingProse: "",
			userMessageIds: new Set(),
		},
		eventHandlers: {
			message_start: ({ event, state }) => {
				if (event.forkId !== null) return state;
				if (event.destination.kind !== "user") return state;
				return {
					...state,
					userMessageIds: new Set(state.userMessageIds).add(event.id),
				};
			},
			message_chunk: ({ event, state }) => {
				if (event.forkId !== null) return state;
				if (!state.userMessageIds.has(event.id)) return state;
				return {
					...state,
					pendingProse: state.pendingProse + event.text,
				};
			},
			turn_outcome: ({ event, state }) => {
				if (event.forkId !== null) return state;
				const prose = state.pendingProse.trim();
				if (!prose) {
					return { ...state, pendingProse: "", userMessageIds: new Set() };
				}
				return {
					entries: [...state.entries, { role: "lead", text: prose }],
					pendingProse: "",
					userMessageIds: new Set(),
				};
			},
		},
		signalHandlers: (on) => [
			on(UserMessageResolutionProjection.signals.userMessageResolved, ({ value, state }) => {
				if (value.forkId !== null) return state;
				const text = textOf(value.content);
				if (!text.trim()) return state;
				return {
					...state,
					entries: [...state.entries, { role: "user", text }],
				};
			}),
		],
	});
