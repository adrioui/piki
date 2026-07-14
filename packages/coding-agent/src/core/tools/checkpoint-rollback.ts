import type { AgentToolResult, AgentToolUpdateCallback } from "@piki/agent-core";
import type { ShadowVcs } from "@piki/vcs";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { createRestoreSnapshotToolDefinition } from "./restore-snapshot.ts";

const checkpointRollbackSchema = Type.Object({
	since: Type.String({ description: 'HH:MM:SS timestamp from a --- separator, e.g. "01:35:00"' }),
	glob: Type.String({
		description: 'Glob pattern for files to roll back, e.g. "src/auth*", "**/*.test.ts", "package.json". Required.',
	}),
});

export type CheckpointRollbackInput = Static<typeof checkpointRollbackSchema>;

export function createCheckpointRollbackToolDefinition(
	cwd: string,
	sessionId: string,
	_shadowVcs?: ShadowVcs,
): ToolDefinition<typeof checkpointRollbackSchema> {
	const restore = createRestoreSnapshotToolDefinition(cwd, sessionId);
	return {
		name: "checkpoint_rollback",
		label: "checkpoint_rollback",
		description:
			"Roll back changes you made since a turn boundary. Operates on your private checkpoint system, not the user's git repository. Use the exact HH:MM:SS timestamp from a --- separator in your conversation. The glob parameter is required to prevent accidentally reverting unrelated changes.",
		parameters: checkpointRollbackSchema,
		execute: async (
			toolCallId: string,
			params: CheckpointRollbackInput,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> =>
			restore.execute(
				toolCallId,
				{ snapshot: params.since, requiredGlob: params.glob, path: params.glob },
				signal,
				onUpdate,
				ctx,
			),
	};
}
