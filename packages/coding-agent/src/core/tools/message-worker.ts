import { createRoleControlTool } from "./role-control-tool.ts";

export function createMessageWorkerToolDefinition() {
	return createRoleControlTool("message_worker", "Send a message to a worker agent.");
}
