import type { AgentToolUpdateCallback } from "@piki/agent-core";

export interface ToolEmission<T = unknown> {
	type: string;
	payload: T;
}

export function emitToolUpdate<T>(
	emission: ToolEmission<T>,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): void {
	onUpdate?.({
		content: [{ type: "text", text: JSON.stringify(emission.payload) }],
		details: emission,
	});
}
