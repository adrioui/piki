import { createRoleControlTool } from "./role-control-tool.ts";

export function createSpawnWorkerToolDefinition() {
	return createRoleControlTool("spawnWorker", "Spawn an event-core worker agent.");
}
