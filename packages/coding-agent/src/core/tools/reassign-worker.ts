import { createRoleControlTool } from "./role-control-tool.ts";

export function createReassignWorkerToolDefinition() {
	return createRoleControlTool("reassign_worker", "Reassign a task to a different worker.");
}
