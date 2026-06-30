import { createRoleControlTool } from "./role-control-tool.ts";

export function createFinishGoalToolDefinition() {
	return createRoleControlTool("finishGoal", "Mark the current goal as finished.");
}
