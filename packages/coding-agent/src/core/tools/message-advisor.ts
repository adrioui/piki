import { createRoleControlTool } from "./role-control-tool.ts";

export function createMessageAdvisorToolDefinition() {
	return createRoleControlTool("message_advisor", "Ask the advisor for guidance.");
}
