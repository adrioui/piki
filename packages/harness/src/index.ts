// Turn layer — harness orchestration

export type {
	HarnessConfig,
	HarnessHooks,
	ModelInterface,
	ModelStreamOptions,
	ModelStreamResult,
	ReplayTurnResult,
	TurnResult,
} from "./turn/harness.ts";
export { createHarness } from "./turn/harness.ts";

// Turn layer — reducers
export {
	CanonicalAccumulatorReducer,
	canonicalAccumulatorInitial,
	canonicalAccumulatorStep,
	createToolHandleReducer,
	createTurnReducer,
	EngineStateReducer,
	engineStateInitial,
	engineStateStep,
} from "./turn/reducers.ts";
export type {
	AssistantMessage,
	CanonicalAccumulatorState,
	CanonicalProjection,
	EngineState,
	EngineToolOutcome,
	MessageDelta,
	Outcome,
	Reducer,
	ThoughtDelta,
	ToolCallMeta,
	ToolCallPart,
	ToolResult,
	TurnEnd,
	TurnEvent,
	TurnState,
	Usage,
} from "./turn/types.ts";

// Tool layer

// Content layer
export {
	ContentBuilder,
	type ContentPart,
	type ImagePart,
	type TextPart,
} from "./content.ts";
// Formatting layer
export {
	isImageValue,
	isScalar,
	renderFieldInto,
	renderScalar,
	renderTagged,
	renderToolOutput,
	renderValueInto,
	toImagePart,
} from "./formatting/helpers.ts";
export { renderExpectedParams } from "./formatting/schema-render.ts";
export {
	createToolResultFormatter,
	type DeniedResult,
	type ErrorResult,
	type InputRejectedResult,
	type InterruptedResult_ as InterruptedToolResult,
	type SuccessResult,
	type ToolResultContext,
	type ToolResultEntry,
	type ToolResultFormatter,
	type ToolResultTag,
} from "./formatting/tool-result-formatter.ts";
export { defineStateModel } from "./tool/state-model.ts";
export {
	applyFieldChunk,
	extractStreamingPartialValues,
	type StreamingPartial,
} from "./tool/streaming-partial.ts";
export {
	defineHarnessTool,
	type HarnessTool,
	type HarnessToolConfig,
	type HarnessToolDefinition,
	type HarnessToolStream,
	StreamValidationError,
} from "./tool/tool.ts";

export type {
	InterruptedResult,
	ToolLifecycleEvent,
	ToolLifecycleEventTag,
} from "./tool/tool-events.ts";
export {
	createToolHandle,
	isToolLifecycleEvent,
	type ToolHandle,
	type ToolStateModel,
	type ToolStateReducer,
} from "./tool/tool-handle.ts";
export {
	defineToolkit,
	mergeToolkits,
} from "./tool/toolkit.ts";
