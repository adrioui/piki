import { createRoleControlTool } from "./role-control-tool.ts";

export function createUpdateTaskToolDefinition() {
	return createRoleControlTool("update_task", "Update an event-core task status.");
}
