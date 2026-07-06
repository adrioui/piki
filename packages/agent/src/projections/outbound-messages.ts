import {
	createSignal,
	type EventEnvelope,
	type ProjectionDefinition,
	type Signal,
	type SignalDefinition,
} from "@piki/event-core/types";

// ─── Types ──────────────────────────────────────────────────────────────────

type Destination = { kind: "user" } | { kind: "coordinator" } | { kind: "worker"; agentId: string };

interface PendingMessage {
	forkId: string | null;
	destination: Destination;
	text: string;
}

interface CompletedMessage {
	id: string;
	forkId: string | null;
	destination: Destination;
	text: string;
	targetForkId: string | null;
	userFacing: boolean;
	timestamp: string;
}

export interface OutboundMessagesState {
	/** Messages currently being accumulated (message_start → chunks → message_end). */
	pendingMessages: Record<string, PendingMessage>;
	/** Messages that completed this tick; drained by extractSignals. */
	completedMessages: CompletedMessage[];
	/** forkId → parentForkId mapping, built from agent_created events. */
	forkParentMap: Record<string, string | null>;
	/** agentId → forkId mapping, built from agent_created events. */
	agentForkMap: Record<string, string>;
}

export const OutboundMessagesSignals = {
	messageCompleted: createSignal(
		"OutboundMessages/messageCompleted",
		"Emitted when an outbound message finishes streaming",
	),
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

type Bag = Record<string, unknown>;

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function bag(value: unknown): Bag {
	return (value ?? {}) as Bag;
}

function resolveDestination(raw: unknown): Destination {
	const d = bag(raw);
	const kind = str(d.kind, "user");
	if (kind === "coordinator") return { kind: "coordinator" };
	if (kind === "worker") return { kind: "worker", agentId: str(d.agentId) };
	return { kind: "user" };
}

function resolveRouting(
	state: OutboundMessagesState,
	forkId: string | null,
	destination: Destination,
): { targetForkId: string | null; userFacing: boolean } {
	switch (destination.kind) {
		case "user":
			return { targetForkId: null, userFacing: true };
		case "coordinator": {
			if (forkId === null) return { targetForkId: null, userFacing: false };
			const parentForkId = state.forkParentMap[forkId] ?? null;
			return { targetForkId: parentForkId, userFacing: false };
		}
		case "worker": {
			const targetForkId = state.agentForkMap[destination.agentId] ?? null;
			return { targetForkId, userFacing: false };
		}
	}
}

// ─── Projection factory ─────────────────────────────────────────────────────

export function createOutboundMessagesProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	OutboundMessagesState
> {
	return {
		name: "OutboundMessages",
		reads: ["AgentRouting"],
		writes: [],
		signals: [OutboundMessagesSignals.messageCompleted] as SignalDefinition[],
		initialState: (): OutboundMessagesState => ({
			pendingMessages: {},
			completedMessages: [],
			forkParentMap: {},
			agentForkMap: {},
		}),
		reduce: reduceOutboundMessages as (state: OutboundMessagesState, event: TEvent) => OutboundMessagesState,
		extractSignals: extractOutboundSignals as (state: OutboundMessagesState, event: TEvent) => Signal[],
	};
}

// ─── Reduce ─────────────────────────────────────────────────────────────────

function reduceOutboundMessages<TEvent extends EventEnvelope = EventEnvelope>(
	state: OutboundMessagesState,
	event: TEvent,
): OutboundMessagesState {
	const p = (event.payload ?? {}) as Bag;

	// Drain completed messages from the previous tick.
	let workingState = state;
	if (workingState.completedMessages.length > 0) {
		workingState = { ...workingState, completedMessages: [] };
	}

	switch (event.type) {
		case "agent_created": {
			const forkId = str(p.forkId, str(p.agentId));
			const agentId = str(p.agentId, forkId);
			if (!forkId) return workingState;
			const parentForkId = p.parentForkId ? str(p.parentForkId) : null;
			return {
				...workingState,
				forkParentMap: { ...workingState.forkParentMap, [forkId]: parentForkId },
				agentForkMap: agentId ? { ...workingState.agentForkMap, [agentId]: forkId } : workingState.agentForkMap,
			};
		}

		case "message_start": {
			const id = str(p.id);
			if (!id) return workingState;
			const forkId = p.forkId != null ? str(p.forkId) : null;
			const destination = resolveDestination(p.destination);
			return {
				...workingState,
				pendingMessages: {
					...workingState.pendingMessages,
					[id]: { forkId, destination, text: "" },
				},
			};
		}

		case "message_chunk": {
			const id = str(p.id);
			const entry = workingState.pendingMessages[id];
			if (!entry) return workingState;
			return {
				...workingState,
				pendingMessages: {
					...workingState.pendingMessages,
					[id]: { ...entry, text: entry.text + str(p.text) },
				},
			};
		}

		case "message_end": {
			const id = str(p.id);
			const entry = workingState.pendingMessages[id];
			if (!entry) return workingState;
			const { [id]: _, ...remaining } = workingState.pendingMessages;
			const { targetForkId, userFacing } = resolveRouting(workingState, entry.forkId, entry.destination);
			const completed: CompletedMessage = {
				id,
				forkId: entry.forkId,
				destination: entry.destination,
				text: entry.text,
				targetForkId,
				userFacing,
				timestamp: event.timestamp,
			};
			return {
				...workingState,
				pendingMessages: remaining,
				completedMessages: [...workingState.completedMessages, completed],
			};
		}

		default:
			return workingState;
	}
}

// ─── Signal extraction ──────────────────────────────────────────────────────

function extractOutboundSignals<TEvent extends EventEnvelope = EventEnvelope>(
	state: OutboundMessagesState,
	_event: TEvent,
): Signal[] {
	if (state.completedMessages.length === 0) return [];
	return state.completedMessages.map(
		(msg): Signal => ({
			type: OutboundMessagesSignals.messageCompleted.type,
			payload: {
				id: msg.id,
				forkId: msg.forkId,
				destination: msg.destination,
				text: msg.text,
				targetForkId: msg.targetForkId,
				userFacing: msg.userFacing,
				timestamp: msg.timestamp,
			},
		}),
	);
}
