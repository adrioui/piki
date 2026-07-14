/** All tool lifecycle event tags handled by the tool handle. Matches capture L72082-72089. */
export type ToolLifecycleEventTag =
	| "ToolInputStarted"
	| "ToolInputFieldChunk"
	| "ToolInputFieldComplete"
	| "ToolInputReady"
	| "ToolInputRejected"
	| "ToolExecutionStarted"
	| "ToolExecutionEnded"
	| "ToolEmission";

/** A tool lifecycle event — discriminated union base. */
export interface ToolLifecycleEvent {
	readonly _tag: ToolLifecycleEventTag;
	readonly toolCallId: string;
	readonly toolKey: string;
}

/** Interrupted result marker. Matches capture L72115-72119. */
export interface InterruptedResult {
	readonly _tag: "Interrupted";
}
