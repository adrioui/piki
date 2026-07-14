import { define } from "./projection.ts";

export interface AgentInfo {
	agentId: string;
	forkId: string;
	taskId: string;
	status: "working" | "idle" | "killed";
	mode: "spawn" | "clone";
	context: string;
}

export interface AgentStatusState {
	agents: Map<string, AgentInfo>;
	agentByForkId: Map<string, string>;
}

export const AgentStatusProjection = define<AgentStatusState>()({
	name: "AgentStatus",
	initial: { agents: new Map(), agentByForkId: new Map() },
	signals: {
		agentCreated: { name: "AgentStatus/created" },
		agentBecameIdle: { name: "AgentStatus/agentBecameIdle" },
		agentBecameWorking: { name: "AgentStatus/agentBecameWorking" },
		agentKilled: { name: "AgentStatus/agentKilled" },
		subagentUserKilled: { name: "AgentStatus/subagentUserKilled" },
		workerIdleClosed: { name: "AgentStatus/workerIdleClosed" },
	},
	eventHandlers: {},
});
