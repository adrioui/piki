import { createRoleControlTool } from "./role-control-tool.ts";

export function createKillWorkerToolDefinition() {
	return createRoleControlTool("kill_worker", "Kill a worker agent.");
}
