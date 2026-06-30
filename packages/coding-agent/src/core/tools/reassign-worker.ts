import { createRoleControlTool } from "./role-control-tool.ts";

export function createReassignWorkerToolDefinition() {
	return createRoleControlTool("reassignWorker", "Reassign a task to a different worker.");
}
