/**
 * Window render barrel.
 */

export { createAgentFormatter, createTruncatingFormatter } from "./formatters.ts";
export { type WindowToPromptInput, windowToPrompt } from "./full.ts";
export {
	contextEntryToMessages,
	ensureTerminalUserMessage,
	renderFeedback,
	renderFeedbackText,
	systemEntryToMessages,
} from "./shared.ts";
export {
	createTimeBoundaryEmitter,
	formatDayTime,
	formatTime,
	type TimeBoundaryEmitter,
} from "./time-boundaries.ts";
export {
	defaultUserMessageOptions,
	renderTimelineUserMessageParts,
	type UserMessagePartOptions,
} from "./user-message-parts.ts";
