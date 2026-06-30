import { createRoleControlTool } from "./role-control-tool.ts";

export function createUpdateTaskToolDefinition() {
	return createRoleControlTool("updateTask", "Update an event-core task status.");
}
