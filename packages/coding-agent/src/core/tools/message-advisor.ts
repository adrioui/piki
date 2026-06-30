import { createRoleControlTool } from "./role-control-tool.ts";

export function createMessageAdvisorToolDefinition() {
	return createRoleControlTool("messageAdvisor", "Ask the advisor for guidance.");
}
