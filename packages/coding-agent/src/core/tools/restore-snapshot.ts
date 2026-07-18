/**
 * restore_snapshot tool: Restore the working tree to a previous snapshot.
 */

import type { AgentToolResult } from "@piki/agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	createCheckpointId,
	createSnapshot,
	DEFAULT_SNAPSHOT_RETENTION,
	diffSnapshotAgainstWorktree,
	resolveSnapshotSelector,
	restoreSnapshot,
} from "../snapshot.ts";

const restoreSnapshotSchema = Type.Object({
	snapshot: Type.String({
		description:
			"Snapshot selector to restore. Supports latest, previous, numeric index, timestamp, message ID, or tree OID.",
	}),
	path: Type.Optional(Type.String({ description: "Restrict restore to this path (default: entire working tree)" })),
	requiredGlob: Type.Optional(
		Type.String({
			description: "Only restore if the selected checkpoint has changes matching this glob.",
		}),
	),
});

export type RestoreSnapshotInput = Static<typeof restoreSnapshotSchema>;

/**
 * Create the restore_snapshot tool definition.
 */
export function createRestoreSnapshotToolDefinition(
	cwd: string,
	sessionId: string,
): ToolDefinition<typeof restoreSnapshotSchema> {
	return {
		name: "restore_snapshot",
		label: "Restore Snapshot",
		description:
			"Restore the working tree to a previous git tree snapshot, undoing all file changes since that snapshot was taken.",
		promptSnippet: "Restore working tree to a previous snapshot",
		promptGuidelines: [
			"Restoring a snapshot will overwrite files in your working tree, including deleting files that were created after the snapshot.",
		],
		parameters: restoreSnapshotSchema,
		execute: async (
			_toolCallId: string,
			params: Static<typeof restoreSnapshotSchema>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> => {
			try {
				const snapshot = resolveSnapshotSelector(cwd, sessionId, params.snapshot);
				if (!snapshot) {
					return {
						content: [{ type: "text" as const, text: `No snapshot found matching ${params.snapshot}` }],
						details: { snapshot: params.snapshot, path: params.path ?? "." },
					};
				}
				if (params.requiredGlob) {
					const { changedFiles } = diffSnapshotAgainstWorktree(cwd, snapshot.treeOID, params.requiredGlob);
					if (changedFiles.length === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Refusing restore: no changed files match required glob ${params.requiredGlob}`,
								},
							],
							details: { snapshot, path: params.path ?? ".", requiredGlob: params.requiredGlob },
						};
					}
				}
				const redoSnapshotId = createCheckpointId("redo");
				const redoTreeOID = createSnapshot(cwd, sessionId, redoSnapshotId, DEFAULT_SNAPSHOT_RETENTION);
				restoreSnapshot(cwd, snapshot.treeOID, params.path);
				return {
					content: [
						{
							type: "text" as const,
							text: `Restored working tree to snapshot ${snapshot.messageId} (${snapshot.treeOID})`,
						},
					],
					details: { snapshot, path: params.path ?? ".", redoSnapshotId, redoTreeOID },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to restore snapshot: ${message}` }],
					details: { snapshot: params.snapshot, path: params.path ?? ".", error: message },
				};
			}
		},
	};
}
