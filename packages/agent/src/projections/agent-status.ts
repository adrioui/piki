// packages/agent/src/projections/agent-status.ts
//
// AgentStatusProjection tracks the set of spawned/active agents keyed by agentId
// and forkId, and emits lifecycle signals.

import { defineProjection, type EffectProjectionDefinition } from "@piki/event-core";
import { outcomeWillChainContinue } from "./task-worker.ts";

export interface AgentInfo {
	readonly agentId: string;
	readonly forkId: string;
	readonly parentForkId: string | null;
	readonly name: unknown;
	readonly role: unknown;
	readonly context: string;
	readonly mode: "spawn" | "clone";
	readonly taskId: string;
	readonly message: unknown;
	readonly status: "working" | "idle" | "killed";
}

export interface AgentStatusState {
	readonly agents: Map<string, AgentInfo>;
	readonly agentByForkId: Map<string, string>;
}

function getAgentByForkId(state: AgentStatusState, forkId: string): AgentInfo | undefined {
	const agentId = state.agentByForkId.get(forkId);
	if (!agentId) return undefined;
	return state.agents.get(agentId);
}

function removeKilledAgent(args: { forkId: string; agentId: string; timestamp: number; state: AgentStatusState }): {
	state: AgentStatusState;
	agent: AgentInfo | null;
} {
	const { forkId, agentId, state } = args;
	const agent = getAgentByForkId(state, forkId);
	if (!agent) return { state, agent: null };
	if (agent.agentId !== agentId) return { state, agent: null };
	const nextAgents = new Map(state.agents);
	nextAgents.delete(agent.agentId);
	const nextByFork = new Map(state.agentByForkId);
	nextByFork.delete(forkId);
	return {
		state: {
			...state,
			agents: nextAgents,
			agentByForkId: nextByFork,
		},
		agent,
	};
}

export const AgentStatusProjection: EffectProjectionDefinition<AgentStatusState> = defineProjection()<AgentStatusState>(
	{
		name: "AgentStatus",
		initial: {
			agents: new Map(),
			agentByForkId: new Map(),
		},
		signals: {
			agentCreated: { name: "AgentStatus/created" },
			agentBecameIdle: { name: "AgentStatus/agentBecameIdle" },
			agentBecameWorking: { name: "AgentStatus/agentBecameWorking" },
			agentKilled: { name: "AgentStatus/agentKilled" },
			subagentUserKilled: { name: "AgentStatus/subagentUserKilled" },
			workerIdleClosed: { name: "AgentStatus/workerIdleClosed" },
		},
		eventHandlers: {
			agent_created: ({ event, state, emit }) => {
				const normalizedMode = event.mode === "clone" ? "clone" : "spawn";
				const normalizedContext = typeof event.context === "string" ? event.context : "";
				if (typeof event.taskId !== "string" || event.taskId.trim().length === 0) {
					return state;
				}
				const normalizedTaskId = event.taskId;
				const existingAgent = state.agents.get(event.agentId);
				if (existingAgent) {
					throw new Error(
						`[AgentStatusProjection] Invalid state transition: agent_created for already existing agent ${event.agentId} (forkId: ${existingAgent.forkId})`,
					);
				}
				const existingForkAgentId = state.agentByForkId.get(event.forkId);
				if (existingForkAgentId) {
					throw new Error(
						`[AgentStatusProjection] Invalid state transition: agent_created for already indexed fork ${event.forkId} (agentId: ${existingForkAgentId})`,
					);
				}
				emit.agentCreated({
					forkId: event.forkId,
					parentForkId: event.parentForkId,
					agentId: event.agentId,
					name: event.name,
					role: event.role,
					taskId: normalizedTaskId,
					mode: normalizedMode,
					context: normalizedContext,
					timestamp: event.timestamp,
				});
				const agent: AgentInfo = {
					agentId: event.agentId,
					forkId: event.forkId,
					parentForkId: event.parentForkId,
					name: event.name,
					role: event.role,
					context: normalizedContext,
					mode: normalizedMode,
					taskId: normalizedTaskId,
					message: event.message ?? null,
					status: "working",
				};
				return {
					...state,
					agents: new Map(state.agents).set(event.agentId, agent),
					agentByForkId: new Map(state.agentByForkId).set(event.forkId, event.agentId),
				};
			},
			turn_started: ({ event, state, emit }) => {
				if (event.forkId === null) return state;
				const agent = getAgentByForkId(state, event.forkId);
				if (!agent) return state;
				if (agent.status !== "working") {
					emit.agentBecameWorking({
						agentId: agent.agentId,
						forkId: agent.forkId,
						role: agent.role,
						parentForkId: agent.parentForkId,
						timestamp: event.timestamp,
					});
				}
				return {
					...state,
					agents: new Map(state.agents).set(agent.agentId, { ...agent, status: "working" }),
				};
			},
			turn_outcome: ({ event, state, emit }) => {
				if (event.forkId === null) return state;
				if (outcomeWillChainContinue(event.outcome)) return state;
				const agent = getAgentByForkId(state, event.forkId);
				if (!agent) return state;
				const reason =
					event.outcome._tag === "Cancelled"
						? "interrupt"
						: event.outcome._tag === "Completed"
							? "stable"
							: "error";
				if (agent.status !== "idle") {
					emit.agentBecameIdle({
						agentId: agent.agentId,
						forkId: agent.forkId,
						role: agent.role,
						parentForkId: agent.parentForkId,
						reason,
						timestamp: event.timestamp,
					});
				}
				return {
					...state,
					agents: new Map(state.agents).set(agent.agentId, { ...agent, status: "idle" }),
				};
			},
			interrupt: ({ event, state, emit }) => {
				if (event.forkId === null) return state;
				const agent = getAgentByForkId(state, event.forkId);
				if (!agent) return state;
				if (agent.status !== "idle") {
					emit.agentBecameIdle({
						agentId: agent.agentId,
						forkId: agent.forkId,
						role: agent.role,
						parentForkId: agent.parentForkId,
						reason: "interrupt",
						timestamp: event.timestamp,
					});
				}
				return {
					...state,
					agents: new Map(state.agents).set(agent.agentId, { ...agent, status: "idle" }),
				};
			},
			agent_killed: ({ event, state, emit }) => {
				const removed = removeKilledAgent({
					forkId: event.forkId,
					agentId: event.agentId,
					timestamp: event.timestamp,
					state,
				});
				if (!removed.agent) return state;
				emit.agentKilled({
					agentId: removed.agent.agentId,
					forkId: removed.agent.forkId,
					parentForkId: removed.agent.parentForkId,
					role: removed.agent.role,
					title: removed.agent.name,
					reason: event.reason,
					timestamp: event.timestamp,
				});
				return removed.state;
			},
			subagent_user_killed: ({ event, state, emit }) => {
				const removed = removeKilledAgent({
					forkId: event.forkId,
					agentId: event.agentId,
					timestamp: event.timestamp,
					state,
				});
				if (!removed.agent) return state;
				emit.subagentUserKilled({
					agentId: removed.agent.agentId,
					forkId: removed.agent.forkId,
					parentForkId: removed.agent.parentForkId,
					role: removed.agent.role,
					title: removed.agent.name,
					source: event.source,
					timestamp: event.timestamp,
				});
				return removed.state;
			},
			worker_idle_closed: ({ event, state, emit }) => {
				const removed = removeKilledAgent({
					forkId: event.forkId,
					agentId: event.agentId,
					timestamp: event.timestamp,
					state,
				});
				if (!removed.agent) return state;
				emit.workerIdleClosed({
					agentId: removed.agent.agentId,
					forkId: removed.agent.forkId,
					parentForkId: removed.agent.parentForkId,
					role: removed.agent.role,
					title: removed.agent.name,
					source: event.source,
					timestamp: event.timestamp,
				});
				return removed.state;
			},
			agent_task_changed: ({ event, state }) => {
				const agent = state.agents.get(event.agentId);
				if (!agent) return state;
				return {
					...state,
					agents: new Map(state.agents).set(event.agentId, { ...agent, taskId: event.newTaskId }),
				};
			},
		},
	},
);
