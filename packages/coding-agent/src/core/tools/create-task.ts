import { createRoleControlTool } from "./role-control-tool.ts";

export function createCreateTaskToolDefinition() {
	return createRoleControlTool("createTask", "Create an event-core task.");
}
