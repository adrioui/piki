// packages/agent/src/projections/agent-routing.ts
//
// AgentRoutingProjection tracks message routing between the coordinator and
// spawned worker agents: pending messages, deferred parent messages, and the
// registered route table. Tracks message routing between the coordinator and
// (`AgentRoutingProjection`). Branding stays "piki".

import { defineProjection, type EffectProjectionDefinition } from "@piki/event-core";
import { outcomeWillChainContinue } from "./task-worker.ts";

interface RoutingEntry {
	readonly agentId: string;
	readonly forkId: string;
	readonly parentForkId: string | null;
}

interface PendingMessage {
	readonly forkId: string | null;
	readonly destination: {
		readonly kind: string;
		readonly agentId?: string;
	};
	readonly text: string;
	readonly order: number;
	readonly targetAgentId: string | null;
}

interface DeferredParentMessage extends PendingMessage {
	readonly text: string;
}

interface AgentRoutingState {
	readonly agents: Map<string, RoutingEntry>;
	readonly agentByForkId: Map<string, string>;
	readonly pendingMessages: Map<string, PendingMessage>;
	readonly deferredParentMessages: Map<string, DeferredParentMessage[]>;
}

function getRoutingEntry(state: AgentRoutingState, agentId: string): RoutingEntry | undefined {
	return state.agents.get(agentId);
}

function getRoutingEntryByForkId(state: AgentRoutingState, forkId: string): RoutingEntry | undefined {
	const agentId = state.agentByForkId.get(forkId);
	if (!agentId) return undefined;
	return state.agents.get(agentId);
}

function isActiveRoute(state: AgentRoutingState, agentId: string): boolean {
	return state.agents.has(agentId);
}

function removeAgentRoutingState(
	state: AgentRoutingState,
	args: { forkId: string; agentId: string },
): AgentRoutingState {
	const routedAgentId = state.agentByForkId.get(args.forkId);
	if (!routedAgentId) return state;
	if (routedAgentId !== args.agentId) return state;
	const agents = new Map(state.agents);
	agents.delete(args.agentId);
	const agentByForkId = new Map(state.agentByForkId);
	agentByForkId.delete(args.forkId);
	const pendingMessages = new Map(state.pendingMessages);
	for (const [id, pending] of pendingMessages.entries()) {
		if (pending.forkId === args.forkId || pending.targetAgentId === args.agentId) {
			pendingMessages.delete(id);
		}
	}
	const deferredParentMessages = new Map(state.deferredParentMessages);
	deferredParentMessages.delete(args.forkId);
	return {
		...state,
		agents,
		agentByForkId,
		pendingMessages,
		deferredParentMessages,
	};
}

export const AgentRoutingProjection: EffectProjectionDefinition<AgentRoutingState> =
	defineProjection()<AgentRoutingState>({
		name: "AgentRouting",
		reads: [],
		initial: {
			agents: new Map(),
			agentByForkId: new Map(),
			pendingMessages: new Map(),
			deferredParentMessages: new Map(),
		},
		signals: {
			agentRegistered: { name: "AgentRouting/registered" },
			agentMessage: { name: "AgentRouting/message" },
			agentResponse: { name: "AgentRouting/response" },
			communicationStreamStarted: { name: "AgentRouting/communicationStreamStarted" },
			communicationStreamChunk: { name: "AgentRouting/communicationStreamChunk" },
			communicationStreamCompleted: { name: "AgentRouting/communicationStreamCompleted" },
			invalidExplicitDestination: { name: "AgentRouting/invalidExplicitDestination" },
		},
		eventHandlers: {
			agent_created: ({ event, state, emit }) => {
				const existingAgent = state.agents.get(event.agentId);
				if (existingAgent) {
					throw new Error(
						`[AgentRoutingProjection] Invalid state transition: agent_created for already existing agent ${event.agentId} (forkId: ${existingAgent.forkId})`,
					);
				}
				const existingForkAgentId = state.agentByForkId.get(event.forkId);
				if (existingForkAgentId) {
					throw new Error(
						`[AgentRoutingProjection] Invalid state transition: agent_created for already indexed fork ${event.forkId} (agentId: ${existingForkAgentId})`,
					);
				}
				const entry: RoutingEntry = {
					agentId: event.agentId,
					forkId: event.forkId,
					parentForkId: event.parentForkId,
				};
				emit.agentRegistered({ forkId: event.forkId, parentForkId: event.parentForkId, role: event.role });
				return {
					...state,
					agents: new Map(state.agents).set(event.agentId, entry),
					agentByForkId: new Map(state.agentByForkId).set(event.forkId, event.agentId),
				};
			},
			message_start: ({ event, state, emit }) => {
				const destination = event.destination;
				const source = event.forkId === null ? undefined : getRoutingEntryByForkId(state, event.forkId);
				const targetAgentId = destination.kind === "worker" ? destination.agentId : null;
				const pendingMessages = new Map(state.pendingMessages);
				pendingMessages.set(event.id, {
					forkId: event.forkId,
					destination,
					text: "",
					order: event.timestamp,
					targetAgentId,
				});
				if (destination.kind !== "user") {
					if (destination.kind === "coordinator" && event.forkId !== null && source) {
						emit.communicationStreamStarted({
							streamId: event.id,
							targetForkId: source.forkId,
							direction: "to_agent",
							agentId: source.agentId,
							textDelta: "",
							timestamp: event.timestamp,
						});
					} else if (destination.kind === "worker" && targetAgentId && isActiveRoute(state, targetAgentId)) {
						const target = getRoutingEntry(state, targetAgentId);
						if (target) {
							emit.communicationStreamStarted({
								streamId: event.id,
								targetForkId: target.forkId,
								direction: "from_agent",
								agentId: target.agentId,
								textDelta: "",
								timestamp: event.timestamp,
							});
						}
					}
				}
				return { ...state, pendingMessages };
			},
			message_chunk: ({ event, state, emit }) => {
				const entry = state.pendingMessages.get(event.id);
				if (!entry) return state;
				const pendingMessages = new Map(state.pendingMessages);
				pendingMessages.set(event.id, { ...entry, text: entry.text + event.text });
				if (entry.destination.kind !== "user" && event.text.length > 0) {
					if (entry.destination.kind === "coordinator" && entry.forkId !== null) {
						const source = getRoutingEntryByForkId(state, entry.forkId);
						if (source) {
							emit.communicationStreamChunk({
								streamId: event.id,
								targetForkId: source.forkId,
								direction: "to_agent",
								agentId: source.agentId,
								textDelta: event.text,
								timestamp: event.timestamp,
							});
						}
					} else if (
						entry.destination.kind === "worker" &&
						entry.targetAgentId &&
						isActiveRoute(state, entry.targetAgentId)
					) {
						const target = getRoutingEntry(state, entry.targetAgentId);
						if (target) {
							emit.communicationStreamChunk({
								streamId: event.id,
								targetForkId: target.forkId,
								direction: "from_agent",
								agentId: target.agentId,
								textDelta: event.text,
								timestamp: event.timestamp,
							});
						}
					}
				}
				return { ...state, pendingMessages };
			},
			message_end: ({ event, state, emit }) => {
				const entry = state.pendingMessages.get(event.id);
				if (!entry) return state;
				const pendingMessages = new Map(state.pendingMessages);
				pendingMessages.delete(event.id);
				let nextState: AgentRoutingState = { ...state, pendingMessages };
				if (entry.destination.kind === "coordinator" && entry.forkId !== null) {
					const source = getRoutingEntryByForkId(state, entry.forkId);
					if (source) {
						emit.communicationStreamCompleted({
							streamId: event.id,
							targetForkId: source.forkId,
							direction: "to_agent",
							agentId: source.agentId,
							timestamp: event.timestamp,
						});
					}
					const existing: DeferredParentMessage[] = state.deferredParentMessages.get(entry.forkId) ?? [];
					const deferredParentMessages: Map<string, DeferredParentMessage[]> = new Map(
						state.deferredParentMessages,
					);
					deferredParentMessages.set(entry.forkId, [
						...existing,
						{ ...entry, text: entry.text, order: event.timestamp },
					]);
					nextState = { ...nextState, deferredParentMessages };
				}
				if (entry.destination.kind === "worker") {
					const resolvedTargetAgentId = entry.targetAgentId ?? (entry.destination as { agentId?: string }).agentId;
					if (resolvedTargetAgentId && isActiveRoute(state, resolvedTargetAgentId)) {
						const target = getRoutingEntry(state, resolvedTargetAgentId);
						if (target) {
							emit.communicationStreamCompleted({
								streamId: event.id,
								targetForkId: target.forkId,
								direction: "from_agent",
								agentId: target.agentId,
								timestamp: event.timestamp,
							});
							emit.agentMessage({
								targetForkId: target.forkId,
								agentId: resolvedTargetAgentId,
								message: entry.text,
								timestamp: event.timestamp,
							});
						}
					} else {
						emit.invalidExplicitDestination({
							forkId: entry.forkId,
							turnId: event.turnId,
							messageId: event.id,
							agentId: (entry.destination as { agentId?: string }).agentId,
							to: (entry.destination as { agentId?: string }).agentId,
							reason: "no active routed worker at message_end",
							timestamp: event.timestamp,
						});
					}
				}
				return nextState;
			},
			turn_outcome: ({ event, state, emit }) => {
				if (event.forkId === null) return state;
				const messages = state.deferredParentMessages.get(event.forkId);
				if (!messages || messages.length === 0) return state;
				const deferredParentMessages = new Map(state.deferredParentMessages);
				deferredParentMessages.delete(event.forkId);
				if (outcomeWillChainContinue(event.outcome)) {
					return { ...state, deferredParentMessages };
				}
				if (event.outcome._tag !== "Completed") {
					return { ...state, deferredParentMessages };
				}
				const agent = getRoutingEntryByForkId(state, event.forkId);
				if (!agent) {
					return { ...state, deferredParentMessages };
				}
				const fullText = [...messages]
					.sort((a, b) => a.order - b.order)
					.map((message) => message.text)
					.join("\n")
					.trim();
				emit.agentResponse({
					targetForkId: agent.parentForkId,
					agentId: agent.agentId,
					message: fullText,
					timestamp: event.timestamp,
				});
				return { ...state, deferredParentMessages };
			},
			agent_killed: ({ event, state }) =>
				removeAgentRoutingState(state, { forkId: event.forkId, agentId: event.agentId }),
			subagent_user_killed: ({ event, state }) =>
				removeAgentRoutingState(state, { forkId: event.forkId, agentId: event.agentId }),
			worker_idle_closed: ({ event, state }) =>
				removeAgentRoutingState(state, { forkId: event.forkId, agentId: event.agentId }),
		},
	});
