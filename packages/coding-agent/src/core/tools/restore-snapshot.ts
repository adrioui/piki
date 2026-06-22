/**
 * restore_snapshot tool: Restore the working tree to a previous snapshot.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { restoreSnapshot } from "../snapshot.ts";

const restoreSnapshotSchema = Type.Object({
	treeOID: Type.String({ description: "Tree OID of the snapshot to restore" }),
	path: Type.Optional(Type.String({ description: "Restrict restore to this path (default: entire working tree)" })),
});

export type RestoreSnapshotInput = Static<typeof restoreSnapshotSchema>;

/**
 * Create the restore_snapshot tool definition.
 */
export function createRestoreSnapshotToolDefinition(cwd: string): ToolDefinition<typeof restoreSnapshotSchema> {
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
				restoreSnapshot(cwd, params.treeOID, params.path);
				return {
					content: [
						{
							type: "text" as const,
							text: `Restored working tree to snapshot ${params.treeOID}`,
						},
					],
					details: { treeOID: params.treeOID, path: params.path ?? "." },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to restore snapshot: ${message}` }],
					details: { treeOID: params.treeOID, path: params.path ?? ".", error: message },
				};
			}
		},
	};
}
