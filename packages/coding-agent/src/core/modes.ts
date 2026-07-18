export type AgentMode = "default" | "read-only" | "plan" | "build";

export const AGENT_MODES: readonly AgentMode[] = ["default", "read-only", "plan", "build"];

export interface AgentModeToolPolicy {
	tools?: string[];
	excludeTools?: string[];
	noTools?: "all" | "builtin";
}

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const PLANNING_TOOLS = [...READ_ONLY_TOOLS] as const;
const BUILD_TOOLS = ["read", "bash", "shell", "edit", "write", "grep", "find", "ls"] as const;

export function isAgentMode(value: string): value is AgentMode {
	return (AGENT_MODES as readonly string[]).includes(value);
}

export function getAgentModeToolPolicy(mode: AgentMode): AgentModeToolPolicy {
	switch (mode) {
		case "read-only":
			return { tools: [...READ_ONLY_TOOLS] };
		case "plan":
			return { tools: [...PLANNING_TOOLS] };
		case "build":
			return { tools: [...BUILD_TOOLS] };
		case "default":
			return {};
	}
}

export function applyAgentModeToolPolicy(base: AgentModeToolPolicy, mode: AgentMode | undefined): AgentModeToolPolicy {
	if (!mode || mode === "default") return base;
	const policy = getAgentModeToolPolicy(mode);
	return {
		noTools: base.noTools ?? policy.noTools,
		tools: base.tools ?? policy.tools,
		excludeTools: base.excludeTools ?? policy.excludeTools,
	};
}
