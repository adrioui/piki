import { createSignal, type EventEnvelope, type ProjectionDefinition, type Signal } from "../types.ts";

type Bag = Record<string, unknown>;

function payload(event: EventEnvelope): Bag {
	return (event.payload ?? {}) as Bag;
}

export type MessageResolutionStatus = "pending" | "resolved" | "deferred";

export interface UserMessageEntry {
	id: string;
	text: string;
	receivedAt: string;
	status: MessageResolutionStatus;
	resolvedAt: string | null;
	deferredAt: string | null;
}

export interface UserMessageResolutionState {
	messages: Record<string, UserMessageEntry>;
	pendingIds: string[];
	resolvedIds: string[];
	deferredIds: string[];
	activeMessageId: string | null;
}

export const UserMessageResolutionSignals = {
	resolved: createSignal("UserMessageResolution/resolved", "A user message was resolved by a turn outcome"),
	deferred: createSignal("UserMessageResolution/deferred", "A user message was deferred into the followUp queue"),
	pendingChanged: createSignal("UserMessageResolution/pendingChanged", "The set of pending user messages changed"),
} as const;

export function createUserMessageResolutionProjection<
	TEvent extends EventEnvelope = EventEnvelope,
>(): ProjectionDefinition<TEvent, UserMessageResolutionState> {
	return {
		name: "UserMessageResolution",
		reads: ["Conversation", "Turn"],
		writes: [],
		signals: Object.values(UserMessageResolutionSignals),
		initialState: (): UserMessageResolutionState => ({
			messages: {},
			pendingIds: [],
			resolvedIds: [],
			deferredIds: [],
			activeMessageId: null,
		}),
		reduce: reduceUMR,
		extractSignals: extractUMRSignals,
	};
}

function reduceUMR(state: UserMessageResolutionState, event: EventEnvelope): UserMessageResolutionState {
	const p = payload(event);
	switch (event.type) {
		case "user_message": {
			const id = typeof p.messageId === "string" ? p.messageId : "";
			if (!id) return state;
			const text = typeof p.text === "string" ? p.text : "";
			return {
				...state,
				messages: {
					...state.messages,
					[id]: { id, text, receivedAt: event.timestamp, status: "pending", resolvedAt: null, deferredAt: null },
				},
				pendingIds: [...state.pendingIds, id],
				activeMessageId: id,
			};
		}
		case "turn_outcome":
		case "interrupt": {
			const id = state.activeMessageId;
			if (!id) return state;
			const entry = state.messages[id];
			if (!entry || entry.status !== "pending") return state;
			return {
				...state,
				messages: {
					...state.messages,
					[id]: { ...entry, status: "resolved", resolvedAt: event.timestamp },
				},
				pendingIds: state.pendingIds.filter((x) => x !== id),
				resolvedIds: [...state.resolvedIds, id],
				activeMessageId: null,
			};
		}
		case "session.queue_updated": {
			const n = typeof p.followUp === "number" ? p.followUp : 0;
			const id = state.activeMessageId;
			if (n <= 0 || !id) return state;
			const entry = state.messages[id];
			if (!entry || entry.status !== "pending") return state;
			return {
				...state,
				messages: {
					...state.messages,
					[id]: { ...entry, status: "deferred", deferredAt: event.timestamp },
				},
				pendingIds: state.pendingIds.filter((x) => x !== id),
				deferredIds: [...state.deferredIds, id],
				activeMessageId: null,
			};
		}
		default:
			return state;
	}
}

function extractUMRSignals(state: UserMessageResolutionState, event: EventEnvelope): Signal[] {
	const signals: Signal[] = [];
	if ((event.type === "turn_outcome" || event.type === "interrupt") && state.activeMessageId === null) {
		const just = Object.values(state.messages).find((m) => m.resolvedAt === event.timestamp);
		if (just) {
			signals.push({
				type: UserMessageResolutionSignals.resolved.type,
				payload: { messageId: just.id },
			});
		}
	}
	if (event.type === "session.queue_updated" && state.activeMessageId === null) {
		const just = Object.values(state.messages).find((m) => m.deferredAt === event.timestamp);
		if (just) {
			signals.push({
				type: UserMessageResolutionSignals.deferred.type,
				payload: { messageId: just.id },
			});
		}
	}
	if (event.type === "user_message" && state.pendingIds.length > 0) {
		signals.push({
			type: UserMessageResolutionSignals.pendingChanged.type,
			payload: { pendingCount: state.pendingIds.length },
		});
	}
	return signals;
}
