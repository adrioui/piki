import { createRoleControlTool } from "./role-control-tool.ts";

export function createEscalateToolDefinition() {
	return createRoleControlTool("escalate", "Observer tool for escalating difficulty, churn, or frustration.");
}
