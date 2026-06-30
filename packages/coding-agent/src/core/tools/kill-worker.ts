import { createRoleControlTool } from "./role-control-tool.ts";

export function createKillWorkerToolDefinition() {
	return createRoleControlTool("killWorker", "Kill a worker agent.");
}
