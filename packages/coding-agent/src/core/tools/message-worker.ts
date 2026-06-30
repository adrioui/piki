import { createRoleControlTool } from "./role-control-tool.ts";

export function createMessageWorkerToolDefinition() {
	return createRoleControlTool("messageWorker", "Send a message to a worker agent.");
}
