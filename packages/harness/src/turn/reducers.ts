/**
 * Turn reducers — canonical accumulator, engine state, tool-handle relay, and
 * the composite `createTurnReducer` factory.
 *
 */

import { applyFieldChunk, extractStreamingPartialValues } from "../tool/streaming-partial.ts";
import { createToolHandle, type ToolHandle, type ToolStateModel } from "../tool/tool-handle.ts";
import type { ToolkitImpl } from "../tool/toolkit.ts";
import type {
	CanonicalAccumulatorState,
	CanonicalProjection,
	EngineState,
	Reducer,
	ToolCallPart,
	ToolResult,
	TurnEvent,
	TurnState,
} from "./types.ts";

// ── Helpers ──────────────────────────────────────────────────────

function serializeToJsonValue(value: unknown): string | number | boolean | null {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	return JSON.parse(JSON.stringify(value)) as string | number | boolean | null;
}

function extractPartialAsJson(partial: unknown): unknown {
	return serializeToJsonValue(extractStreamingPartialValues(partial));
}

function updateToolCall(
	toolCalls: readonly ToolCallPart[],
	toolCallId: string,
	updater: (tc: ToolCallPart) => ToolCallPart,
): ToolCallPart[] {
	return toolCalls.map((tc) => (tc.id === toolCallId ? updater(tc) : tc));
}

function projectCanonical(acc: CanonicalAccumulatorState): CanonicalProjection {
	return {
		assistantMessage: acc.assistantMessage,
		toolResults: acc.toolResults,
		outcome: acc.outcome,
		usage: acc.usage,
	};
}

// ── Canonical accumulator initial ────────────────────────────────

export const canonicalAccumulatorInitial: CanonicalAccumulatorState = {
	reasoning: "",
	messageText: "",
	toolCallMeta: new Map(),
	toolCallInputs: new Map(),
	toolCallInputChunks: new Map(),
	readyToolCalls: new Set(),
	assistantMessage: { _tag: "AssistantMessage" },
	toolResults: [],
	outcome: null,
	usage: null,
};

// ── Canonical accumulator step ───────────────────────────────────

export function canonicalAccumulatorStep(
	state: CanonicalAccumulatorState,
	event: TurnEvent,
): CanonicalAccumulatorState {
	switch (event._tag) {
		case "ThoughtDelta": {
			const reasoning = state.reasoning + event.text;
			return {
				...state,
				reasoning,
				assistantMessage: { ...state.assistantMessage, reasoning },
			};
		}
		case "MessageDelta": {
			const messageText = state.messageText + event.text;
			return {
				...state,
				messageText,
				assistantMessage: { ...state.assistantMessage, text: messageText || undefined },
			};
		}
		case "ToolInputStarted": {
			const id = event.toolCallId;
			const emptyInput: Record<string, unknown> = {};
			const toolCalls: ToolCallPart[] = [
				...(state.assistantMessage.toolCalls ?? []),
				{
					_tag: "ToolCallPart",
					id,
					providerToolCallId: event.providerToolCallId,
					name: event.toolName,
					input: emptyInput,
				},
			];
			const meta = new Map(state.toolCallMeta);
			meta.set(event.toolCallId, {
				providerToolCallId: event.providerToolCallId,
				toolName: event.toolName,
				toolKey: event.toolKey,
			});
			return {
				...state,
				toolCallMeta: meta,
				assistantMessage: { ...state.assistantMessage, toolCalls },
			};
		}
		case "ToolInputFieldChunk": {
			const chunks = new Map(state.toolCallInputChunks);
			const existing = (chunks.get(event.toolCallId) ?? {}) as Record<string, unknown>;
			chunks.set(event.toolCallId, applyFieldChunk(existing, event.path, event.delta));
			return { ...state, toolCallInputChunks: chunks };
		}
		case "ToolInputReady": {
			const chunks = state.toolCallInputChunks.get(event.toolCallId);
			const inputAsJson =
				chunks && Object.keys(chunks).length > 0 ? (extractPartialAsJson(chunks) as Record<string, unknown>) : {};
			const toolCalls = updateToolCall(state.assistantMessage.toolCalls ?? [], event.toolCallId, (tc) => ({
				...tc,
				input: inputAsJson,
			}));
			const ready = new Set(state.readyToolCalls);
			ready.add(event.toolCallId);
			const inputs = new Map(state.toolCallInputs);
			inputs.set(event.toolCallId, inputAsJson);
			return {
				...state,
				readyToolCalls: ready,
				toolCallInputs: inputs,
				assistantMessage: { ...state.assistantMessage, toolCalls },
			};
		}
		case "ToolExecutionEnded": {
			const result: ToolResult = {
				toolCallId: event.toolCallId,
				providerToolCallId: event.providerToolCallId,
				toolName: event.toolName,
				result: event.result,
			};
			return {
				...state,
				toolResults: [...state.toolResults, result],
			};
		}
		case "ToolInputRejected": {
			const chunks = state.toolCallInputChunks.get(event.toolCallId);
			const partialInput =
				chunks && Object.keys(chunks).length > 0 ? (extractPartialAsJson(chunks) as Record<string, unknown>) : {};
			const result: ToolResult = {
				toolCallId: event.toolCallId,
				providerToolCallId: event.providerToolCallId,
				toolName: event.toolName,
				result: {
					_tag: "InputRejected",
					issue: event.issue,
					partialInput,
				},
			};
			return {
				...state,
				toolResults: [...state.toolResults, result],
			};
		}
		case "TurnEnd": {
			let assistantMessage = state.assistantMessage;
			{
				const toolCalls = (assistantMessage.toolCalls ?? []).map((tc) => {
					if (state.readyToolCalls.has(tc.id)) return tc;
					const chunks = state.toolCallInputChunks.get(tc.id);
					if (chunks && Object.keys(chunks).length > 0) {
						return {
							_tag: "ToolCallPart" as const,
							id: tc.id,
							providerToolCallId: tc.providerToolCallId,
							name: tc.name,
							input: extractPartialAsJson(chunks) as Record<string, unknown>,
						};
					}
					return tc;
				});
				assistantMessage = { ...assistantMessage, toolCalls };
			}
			const toolResults = [...state.toolResults];
			for (const tc of assistantMessage.toolCalls ?? []) {
				if (!toolResults.some((r) => r.toolCallId === tc.id)) {
					toolResults.push({
						toolCallId: tc.id,
						providerToolCallId: tc.providerToolCallId,
						toolName: tc.name,
						result: { _tag: "Interrupted" },
					});
				}
			}
			return {
				...state,
				assistantMessage,
				toolResults,
				outcome: event.outcome,
				usage: event.usage,
			};
		}
		default:
			return state;
	}
}

// ── Canonical accumulator reducer ─────────────────────────────────

export const CanonicalAccumulatorReducer = {
	initial: canonicalAccumulatorInitial,
	step: canonicalAccumulatorStep,
};

// ── Engine state initial ─────────────────────────────────────────

export const engineStateInitial: EngineState = {
	toolCallMap: new Map(),
	toolOutcomes: new Map(),
	deadToolCalls: new Set(),
	stopped: false,
};

// ── Engine state step ────────────────────────────────────────────

export function engineStateStep(state: EngineState, event: TurnEvent): EngineState {
	switch (event._tag) {
		case "ToolInputStarted": {
			const toolCallMap = new Map(state.toolCallMap);
			toolCallMap.set(event.toolCallId, event.toolKey);
			return { ...state, toolCallMap };
		}
		case "ToolExecutionEnded": {
			const toolOutcomes = new Map(state.toolOutcomes);
			toolOutcomes.set(event.toolCallId, { _tag: "Completed" as const, result: event.result });
			return { ...state, toolOutcomes };
		}
		case "ToolInputRejected": {
			const deadToolCalls = new Set(state.deadToolCalls);
			deadToolCalls.add(event.toolCallId);
			return { ...state, deadToolCalls };
		}
		case "TurnEnd": {
			let newState = state;
			if (event.outcome._tag === "ToolInputValidationFailure") {
				const toolCallId = (event.outcome as unknown as { toolCallId: string }).toolCallId;
				const toolOutcomes = new Map(state.toolOutcomes);
				toolOutcomes.set(toolCallId, { _tag: "InputRejected" as const });
				const deadToolCalls = new Set(state.deadToolCalls);
				deadToolCalls.add(toolCallId);
				newState = { ...state, toolOutcomes, deadToolCalls };
			}
			return { ...newState, stopped: true };
		}
		default:
			return state;
	}
}

// ── Engine state reducer ─────────────────────────────────────────

export const EngineStateReducer = {
	initial: engineStateInitial,
	step: engineStateStep,
};

// ── Tool-handle reducer ──────────────────────────────────────────

interface ToolHandleReducerState {
	readonly handles: ReadonlyMap<string, ToolHandle>;
}

export function createToolHandleReducer(toolkit: ToolkitImpl): {
	initial: ToolHandleReducerState;
	step: (state: ToolHandleReducerState, event: TurnEvent) => ToolHandleReducerState;
} {
	const stateModels = new Map<string, unknown>();
	for (const key of toolkit.keys) {
		const entry = (toolkit as unknown as { entries: Record<string, { state?: unknown }> }).entries[key];
		if (entry?.state) {
			stateModels.set(key, entry.state);
		}
	}

	const initial: ToolHandleReducerState = { handles: new Map() };

	function step(state: ToolHandleReducerState, event: TurnEvent): ToolHandleReducerState {
		if (event._tag === "ToolInputStarted") {
			const model = stateModels.get(event.toolKey) as ToolStateModel<unknown> | undefined;
			if (!model) return state;
			const handle = createToolHandle(event.toolCallId, event.providerToolCallId, event.toolKey, model);
			const processed = handle.process(event as never);
			const handles = new Map(state.handles);
			handles.set(event.toolCallId, processed);
			return { handles };
		}

		if (event._tag === "TurnEnd") {
			const handles = new Map(state.handles);
			for (const [id, handle] of handles) {
				const phase = (handle.state as { phase?: string }).phase;
				if (phase !== "completed" && phase !== "error" && phase !== "rejected") {
					handles.set(id, handle.interrupt());
				}
			}
			return { handles };
		}

		if (
			event._tag === "ToolInputFieldChunk" ||
			event._tag === "ToolInputFieldComplete" ||
			event._tag === "ToolInputReady" ||
			event._tag === "ToolInputRejected" ||
			event._tag === "ToolExecutionStarted" ||
			event._tag === "ToolExecutionEnded" ||
			event._tag === "ToolEmission"
		) {
			const existing = state.handles.get(event.toolCallId);
			if (!existing) return state;
			const processed = existing.process(event as never);
			if (processed === existing) return state;
			const handles = new Map(state.handles);
			handles.set(event.toolCallId, processed);
			return { handles };
		}

		return state;
	}

	return { initial, step };
}

// ── Composite turn reducer ───────────────────────────────────────

export function createTurnReducer(toolkit: ToolkitImpl): Reducer<TurnState> {
	const toolHandleReducer = createToolHandleReducer(toolkit);

	const initial: TurnState = {
		_accumulator: CanonicalAccumulatorReducer.initial,
		canonical: projectCanonical(CanonicalAccumulatorReducer.initial),
		engine: EngineStateReducer.initial,
		handles: toolHandleReducer.initial.handles,
	};

	function step(state: TurnState, event: TurnEvent): TurnState {
		const _accumulator = CanonicalAccumulatorReducer.step(state._accumulator, event);
		const canonical = projectCanonical(_accumulator);
		const engine = EngineStateReducer.step(state.engine, event);
		const handleState = toolHandleReducer.step({ handles: state.handles as Map<string, ToolHandle> }, event);
		return { _accumulator, canonical, engine, handles: handleState.handles };
	}

	return { initial, step };
}
