import { createRoleControlTool } from "./role-control-tool.ts";

export function createPassToolDefinition() {
	return createRoleControlTool("pass", "Observer tool indicating no escalation is needed.");
}
