import { createRoleControlTool } from "./role-control-tool.ts";

export function createCreateTaskToolDefinition() {
	return createRoleControlTool("create_task", "Create an event-core task.");
}
