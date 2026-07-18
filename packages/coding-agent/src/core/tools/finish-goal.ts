import { createRoleControlTool } from "./role-control-tool.ts";

export function createFinishGoalToolDefinition() {
	return createRoleControlTool("finish_goal", "Mark the current goal as finished.");
}
