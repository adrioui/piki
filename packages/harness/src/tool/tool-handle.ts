import type { ToolLifecycleEvent, ToolLifecycleEventTag } from "./tool-events.ts";

/** The immutable tool handle — a state machine that processes lifecycle events. */
export interface ToolHandle<TState = unknown> {
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly toolKey: string;
	readonly state: TState;
	readonly process: (event: ToolLifecycleEvent) => ToolHandle<TState>;
	readonly interrupt: () => ToolHandle<TState>;
}

/** Check if an event is a tool lifecycle event. Matches capture L72082-72093. */
export function isToolLifecycleEvent(event: { readonly _tag: string }): event is ToolLifecycleEvent {
	switch (event._tag as ToolLifecycleEventTag) {
		case "ToolInputStarted":
		case "ToolInputFieldChunk":
		case "ToolInputFieldComplete":
		case "ToolInputReady":
		case "ToolInputRejected":
		case "ToolExecutionStarted":
		case "ToolExecutionEnded":
		case "ToolEmission":
			return true;
		default:
			return false;
	}
}

/** Reduce function signature for tool state models. */
export type ToolStateReducer<TState> = (state: TState, event: ToolLifecycleEvent) => TState;

/** State model shape produced by defineStateModel. */
export interface ToolStateModel<TState> {
	readonly initial: TState;
	readonly reduce: ToolStateReducer<TState>;
}

function buildHandle<TState>(
	toolCallId: string,
	providerToolCallId: string,
	toolKey: string,
	state: TState,
	reduce: ToolStateReducer<TState>,
): ToolHandle<TState> {
	return {
		toolCallId,
		providerToolCallId,
		toolKey,
		get state() {
			return state;
		},
		process(event: ToolLifecycleEvent): ToolHandle<TState> {
			if (!isToolLifecycleEvent(event)) return this;
			const reduced = reduce(state, event);
			return buildHandle(toolCallId, providerToolCallId, toolKey, reduced, reduce);
		},
		interrupt(): ToolHandle<TState> {
			const interruptEvent: ToolLifecycleEvent = {
				_tag: "ToolExecutionEnded",
				toolCallId,
				toolKey,
			} as ToolLifecycleEvent;
			return buildHandle(toolCallId, providerToolCallId, toolKey, reduce(state, interruptEvent), reduce);
		},
	};
}

/**
 * Create a tool handle from a state model.
 * Matches capture L72078-72081.
 */
export function createToolHandle<TState>(
	toolCallId: string,
	providerToolCallId: string,
	toolKey: string,
	model: ToolStateModel<TState>,
): ToolHandle<TState> {
	return buildHandle(toolCallId, providerToolCallId, toolKey, model.initial, model.reduce);
}
