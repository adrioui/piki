import { createRoleControlTool } from "./role-control-tool.ts";

export function createSpawnWorkerToolDefinition() {
	return createRoleControlTool("spawn_worker", "Spawn an event-core worker agent.");
}
