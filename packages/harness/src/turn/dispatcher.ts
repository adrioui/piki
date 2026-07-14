/**
 * Effectful single-turn dispatcher — translates raw model stream events
 * into harness events, executing tools and collecting results.
 *
 */

import { Cause, Data, Effect, type Layer, Stream } from "effect";
import type { HarnessTool } from "../tool/tool.ts";
import { StreamValidationError } from "../tool/tool.ts";
import type { ToolkitImpl } from "../tool/toolkit.ts";
import type { EngineState, EngineToolOutcome, Outcome, Usage } from "./types.ts";

// ── TurnAbort ────────────────────────────────────────────────────

export class TurnAbort extends Data.TaggedError("TurnAbort")<{
	readonly outcome: Outcome;
}> {}

// ── Raw model stream events (input side) ─────────────────────────

export interface ThoughtStartEvent {
	readonly _tag: "thought_start";
	readonly level: string;
}

export interface ThoughtDeltaEvent {
	readonly _tag: "thought_delta";
	readonly text: string;
}

export interface ThoughtEndEvent {
	readonly _tag: "thought_end";
}

export interface MessageStartEvent {
	readonly _tag: "message_start";
}

export interface MessageDeltaEvent {
	readonly _tag: "message_delta";
	readonly text: string;
}

export interface MessageEndEvent {
	readonly _tag: "message_end";
}

export interface ToolCallStartEvent {
	readonly _tag: "tool_call_start";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly toolName: string;
}

export interface ToolCallFieldStartEvent {
	readonly _tag: "tool_call_field_start";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly path: readonly string[];
}

export interface ToolCallFieldDeltaEvent {
	readonly _tag: "tool_call_field_delta";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly path: readonly string[];
	readonly delta: string;
}

export interface ToolCallFieldEndEvent {
	readonly _tag: "tool_call_field_end";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly path: readonly string[];
	readonly value: unknown;
}

export interface ToolCallReadyEvent {
	readonly _tag: "tool_call_ready";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
}

export interface StreamEndEvent {
	readonly _tag: "stream_end";
	readonly terminal: StreamTerminal;
}

export type ModelStreamEvent =
	| ThoughtStartEvent
	| ThoughtDeltaEvent
	| ThoughtEndEvent
	| MessageStartEvent
	| MessageDeltaEvent
	| MessageEndEvent
	| ToolCallStartEvent
	| ToolCallFieldStartEvent
	| ToolCallFieldDeltaEvent
	| ToolCallFieldEndEvent
	| ToolCallReadyEvent
	| StreamEndEvent;

// ── Stream terminal ──────────────────────────────────────────────

export interface StreamCompletedTerminal {
	readonly _tag: "StreamCompleted";
	readonly finishReason: string;
	readonly usage: UsageReport;
}

export interface StreamFailedTerminal {
	readonly _tag: "StreamFailed";
	readonly cause: unknown;
}

export type StreamTerminal = StreamCompletedTerminal | StreamFailedTerminal;

export interface UsageReportReported {
	readonly _tag: "UsageReported";
	readonly usage: Usage;
}

export interface NoUsageReport {
	readonly _tag: "NoUsageReport";
}

export type UsageReport = UsageReportReported | NoUsageReport;

// ── Tool input parser (streaming partial → decoded) ──────────────

export interface ToolInputParser {
	readonly partial: unknown;
	readonly decoded: unknown | null;
}

// ── Tool entry (direct HarnessTool from the toolkit) ──────────────

type DispatcherToolEntry = HarnessTool<unknown, unknown, unknown>;

// ── Hooks ────────────────────────────────────────────────────────

export interface BeforeExecuteContext {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly toolKey: string;
	readonly input: unknown;
}

export interface BeforeExecuteDecision {
	readonly _tag: "Proceed";
	readonly modifiedInput?: unknown;
}

export interface BeforeExecuteDeny {
	readonly _tag: "Deny";
	readonly denial: unknown;
}

export type BeforeExecuteResult = BeforeExecuteDecision | BeforeExecuteDeny;

export interface AfterExecuteContext extends BeforeExecuteContext {
	readonly result: unknown;
}

export interface EmissionContext {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly toolKey: string;
	readonly value: unknown;
}

export interface DispatcherHooks {
	readonly beforeExecute?: (ctx: BeforeExecuteContext) => Effect.Effect<BeforeExecuteResult>;
	readonly afterExecute?: (ctx: AfterExecuteContext) => Effect.Effect<void>;
	readonly onEmission?: (ctx: EmissionContext) => Effect.Effect<void>;
}

// ── Emitted harness events (output side) ─────────────────────────
// Closed discriminated union. Every event the dispatcher emits is, by
// construction, one of these variants — no index signature, so exhaustiveness
// is enforced at compile time.

export type EmittedEvent =
	| { readonly _tag: "ThoughtStart"; readonly level: string }
	| { readonly _tag: "ThoughtDelta"; readonly text: string }
	| { readonly _tag: "ThoughtEnd" }
	| { readonly _tag: "MessageStart" }
	| { readonly _tag: "MessageDelta"; readonly text: string }
	| { readonly _tag: "MessageEnd" }
	| {
			readonly _tag: "ToolInputStarted";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
	  }
	| {
			readonly _tag: "ToolInputFieldChunk";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly field: string;
			readonly path: readonly string[];
			readonly delta: string;
	  }
	| {
			readonly _tag: "ToolInputFieldComplete";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly field: string;
			readonly path: readonly string[];
			readonly value: unknown;
	  }
	| { readonly _tag: "ToolInputReady"; readonly toolCallId: string; readonly providerToolCallId: string }
	| {
			readonly _tag: "ToolInputRejected";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
			readonly issue: unknown;
	  }
	| {
			readonly _tag: "ToolExecutionStarted";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
			readonly input: unknown;
			readonly cached: boolean;
	  }
	| {
			readonly _tag: "ToolExecutionEnded";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
			readonly result: unknown;
	  }
	| {
			readonly _tag: "ToolEmission";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
			readonly value: unknown;
	  }
	| { readonly _tag: "TurnEnd"; readonly outcome: Outcome; readonly usage: Usage | null };

// ── Dispatcher config ────────────────────────────────────────────

export interface DispatcherConfig {
	readonly events: Stream.Stream<ModelStreamEvent>;
	readonly parsers: ReadonlyMap<string, ToolInputParser>;
	readonly toolkit: ToolkitImpl;
	readonly emit: (event: EmittedEvent) => Effect.Effect<void>;
	readonly requestId: string;
	readonly layer?: Layer.Layer<never, never, never>;
	readonly initialEngineState?: EngineState;
	readonly maxThoughtChars?: number;
	readonly hooks?: DispatcherHooks;
}

// ── mapFinishReasonToOutcome ─────────────────────────────────────

export function mapFinishReasonToOutcome(reason: string, toolCallCount: number, requestId: string): Outcome {
	switch (reason) {
		case "stop":
		case "end_turn":
		case "tool_calls":
			return { _tag: "Completed", toolCallsCount: toolCallCount, requestId };
		case "length":
			return { _tag: "OutputTruncated", requestId };
		case "content_filter":
			return { _tag: "ContentFiltered", requestId };
		default:
			return { _tag: "Completed", toolCallsCount: toolCallCount, requestId };
	}
}

// ── Tool abort helper ────────────────────────────────────────────

function toolAbort(_config: DispatcherConfig, outcome: Outcome): Effect.Effect<never, TurnAbort> {
	return Effect.fail(new TurnAbort({ outcome }));
}

function withRequestId<T extends { readonly _tag: string }>(
	config: DispatcherConfig,
	outcome: T,
): T & { requestId: string } {
	return { ...outcome, requestId: config.requestId };
}

// ── Stream hook sync wrapper ────────────────────────────────────

function tryStreamHook(
	onInput: (input: Partial<unknown>) => void,
	partial: unknown,
): Effect.Effect<void, StreamValidationError> {
	return Effect.try(() => onInput(partial as Partial<unknown>)).pipe(
		Effect.catchAll((error): Effect.Effect<never, StreamValidationError> => {
			if (error instanceof StreamValidationError) {
				return Effect.fail(error);
			}
			return Effect.die(error);
		}),
	);
}

// ── dispatch ─────────────────────────────────────────────────────

/**
 * Run a single turn: consume the model stream, translate events,
 * execute tools, and emit harness events.
 *
 * Returns an Effect that completes when the stream is exhausted.
 */
export function dispatch(config: DispatcherConfig): Effect.Effect<void> {
	const { toolkit, hooks, emit, initialEngineState } = config;

	// Build lookup maps
	const toolNameToKey = new Map<string, string>();
	const toolKeyToEntry = new Map<string, DispatcherToolEntry>();
	for (const key of toolkit.keys) {
		const entry = toolkit.entries[key]!;
		toolNameToKey.set(entry.definition.name, key);
		toolKeyToEntry.set(key, entry);
	}

	// Seed cached outcomes from prior engine state
	const cachedOutcomes = new Map<string, EngineToolOutcome>();
	if (initialEngineState) {
		for (const [toolCallId, outcome] of initialEngineState.toolOutcomes) {
			cachedOutcomes.set(toolCallId, outcome);
		}
	}

	// Per-tool-call streaming accumulators
	const accumulators = new Map<
		string,
		{
			toolCallId: string;
			providerToolCallId: string;
			toolName: string;
			toolKey: string;
			streamState: unknown;
			streamHook?: DispatcherToolEntry["stream"];
		}
	>();
	let toolCallCount = 0;
	let thoughtCharCount = 0;

	// Tool execution
	function executeTool(
		toolCallId: string,
		providerToolCallId: string,
		toolName: string,
		toolKey: string,
		input: unknown,
	): Effect.Effect<void, TurnAbort> {
		const lookup = toolKeyToEntry.get(toolKey);
		if (!lookup) {
			return toolAbort(
				config,
				withRequestId(config, {
					_tag: "EngineDefect",
					message: `Unknown tool key: ${toolKey}`,
				}),
			);
		}
		const tool = lookup;

		// Check cached outcomes
		const cached = cachedOutcomes.get(toolCallId);
		if (cached && cached._tag === "Completed") {
			return Effect.gen(function* () {
				yield* emit({
					_tag: "ToolExecutionStarted",
					toolCallId,
					providerToolCallId,
					toolName,
					toolKey,
					input,
					cached: true,
				});
				yield* emit({
					_tag: "ToolExecutionEnded",
					toolCallId,
					providerToolCallId,
					toolName,
					toolKey,
					result: cached.result,
				});
				if (hooks?.afterExecute) {
					yield* hooks.afterExecute({
						toolCallId,
						toolName,
						toolKey,
						input,
						result: cached.result,
					});
				}
				const resultTag =
					typeof cached.result === "object" && cached.result !== null && "_tag" in cached.result
						? (cached.result as { readonly _tag: string })._tag
						: undefined;
				if (resultTag === "Error") {
					return yield* toolAbort(
						config,
						withRequestId(config, {
							_tag: "ToolExecutionError",
							toolCallId,
							providerToolCallId,
							toolName,
							toolKey,
							error: (cached.result as { readonly error: unknown }).error,
						}),
					);
				}
			});
		}

		// Fresh execution
		return Effect.gen(function* () {
			// beforeExecute hook
			const hookCtx: BeforeExecuteContext = { toolCallId, toolName, toolKey, input };
			const decision: BeforeExecuteResult = hooks?.beforeExecute
				? yield* hooks.beforeExecute(hookCtx)
				: { _tag: "Proceed" };

			if (decision._tag === "Deny") {
				yield* emit({
					_tag: "ToolExecutionStarted",
					toolCallId,
					providerToolCallId,
					toolName,
					toolKey,
					input,
					cached: false,
				});
				const result = { _tag: "Denied", denial: (decision as BeforeExecuteDeny).denial };
				yield* emit({
					_tag: "ToolExecutionEnded",
					toolCallId,
					providerToolCallId,
					toolName,
					toolKey,
					result,
				});
				return yield* toolAbort(
					config,
					withRequestId(config, {
						_tag: "GateRejected",
						toolCallId,
						providerToolCallId,
						toolName,
					}),
				);
			}

			const effectiveInput =
				decision._tag === "Proceed" && decision.modifiedInput !== undefined ? decision.modifiedInput : input;

			yield* emit({
				_tag: "ToolExecutionStarted",
				toolCallId,
				providerToolCallId,
				toolName,
				toolKey,
				input: effectiveInput,
				cached: false,
			});

			// Execute the tool
			const result = yield* Effect.gen(function* () {
				const toolEffect = tool.execute(effectiveInput);
				const output = yield* toolEffect;
				return { _tag: "Success" as const, output };
			}).pipe(
				Effect.catchAllCause((cause) => {
					const squashed = Cause.squash(cause);
					const error =
						typeof squashed === "object" && squashed !== null && "message" in squashed
							? squashed
							: { message: String(squashed) };
					return Effect.succeed({ _tag: "Error" as const, error });
				}),
			);

			yield* emit({
				_tag: "ToolExecutionEnded",
				toolCallId,
				providerToolCallId,
				toolName,
				toolKey,
				result,
			});

			if (hooks?.afterExecute) {
				yield* hooks.afterExecute({ ...hookCtx, result });
			}

			if (result._tag === "Error") {
				return yield* toolAbort(
					config,
					withRequestId(config, {
						_tag: "ToolExecutionError",
						toolCallId,
						providerToolCallId,
						toolName,
						toolKey,
						error: result.error,
					}),
				);
			}
		});
	}

	// Terminal → outcome mapping
	function terminalToOutcome(terminal: StreamTerminal): Outcome {
		switch (terminal._tag) {
			case "StreamCompleted":
				return mapFinishReasonToOutcome(terminal.finishReason, toolCallCount, config.requestId);
			case "StreamFailed":
				return withRequestId(config, {
					_tag: "StreamFailed",
					message: formatStreamFailureMessage(terminal.cause),
					terminal,
				});
		}
	}

	// Process a single raw model event
	function processEvent(event: ModelStreamEvent) {
		switch (event._tag) {
			case "thought_start": {
				thoughtCharCount = 0;
				return emit({ _tag: "ThoughtStart", level: event.level });
			}
			case "thought_delta": {
				thoughtCharCount += event.text.length;
				if (config.maxThoughtChars !== undefined && thoughtCharCount > config.maxThoughtChars) {
					return toolAbort(
						config,
						withRequestId(config, {
							_tag: "ThoughtLimitExceeded",
							limit: config.maxThoughtChars,
						}),
					);
				}
				return emit({ _tag: "ThoughtDelta", text: event.text });
			}
			case "thought_end":
				return emit({ _tag: "ThoughtEnd" });
			case "message_start":
				return emit({ _tag: "MessageStart" });
			case "message_delta":
				return emit({ _tag: "MessageDelta", text: event.text });
			case "message_end":
				return emit({ _tag: "MessageEnd" });

			case "tool_call_start": {
				const toolKey = toolNameToKey.get(event.toolName);
				if (!toolKey) {
					return toolAbort(
						config,
						withRequestId(config, {
							_tag: "EngineDefect",
							message: `Unknown tool name: ${event.toolName}`,
						}),
					);
				}
				const entry = toolKeyToEntry.get(toolKey);
				if (!entry) {
					return toolAbort(
						config,
						withRequestId(config, {
							_tag: "EngineDefect",
							message: `No entry for tool key: ${toolKey}`,
						}),
					);
				}
				toolCallCount++;
				accumulators.set(event.toolCallId, {
					toolCallId: event.toolCallId,
					providerToolCallId: event.providerToolCallId,
					toolName: event.toolName,
					toolKey,
					streamState: undefined,
					streamHook: entry.stream,
				});
				return emit({
					_tag: "ToolInputStarted",
					toolCallId: event.toolCallId,
					providerToolCallId: event.providerToolCallId,
					toolName: event.toolName,
					toolKey,
				});
			}

			case "tool_call_field_start":
				return Effect.void;

			case "tool_call_field_delta": {
				const acc = accumulators.get(event.toolCallId);
				if (!acc) return Effect.void;
				const field = event.path[0] ?? "";
				return Effect.gen(function* () {
					yield* emit({
						_tag: "ToolInputFieldChunk",
						toolCallId: event.toolCallId,
						providerToolCallId: event.providerToolCallId,
						field,
						path: event.path,
						delta: event.delta,
					});

					// Stream hook validation
					if (acc.streamHook) {
						const parser = config.parsers.get(event.toolCallId);
						if (parser) {
							const partial = parser.partial;
							if (partial) {
								yield* tryStreamHook(acc.streamHook.onInput!, partial).pipe(
									Effect.catchTag("StreamValidationError", (e) =>
										Effect.gen(function* () {
											const issue = { path: [] as readonly string[], message: e.message };
											yield* emit({
												_tag: "ToolInputRejected",
												toolCallId: event.toolCallId,
												providerToolCallId: event.providerToolCallId,
												toolName: acc.toolName,
												toolKey: acc.toolKey,
												issue,
											});
											return yield* toolAbort(
												config,
												withRequestId(config, {
													_tag: "ToolInputValidationFailure",
													toolCallId: acc.toolCallId,
													providerToolCallId: acc.providerToolCallId,
													toolName: acc.toolName,
													toolKey: acc.toolKey,
													issue,
												}),
											);
										}),
									),
								);
							}
						}
					}
				});
			}

			case "tool_call_field_end": {
				const acc = accumulators.get(event.toolCallId);
				if (!acc) return Effect.void;
				const field = event.path[0] ?? "";
				return emit({
					_tag: "ToolInputFieldComplete",
					toolCallId: event.toolCallId,
					providerToolCallId: event.providerToolCallId,
					field,
					path: event.path,
					value: event.value,
				});
			}

			case "tool_call_ready": {
				const acc = accumulators.get(event.toolCallId);
				if (!acc) return Effect.void;
				const parser = config.parsers.get(event.toolCallId);
				if (!parser || parser.decoded === null) {
					return toolAbort(
						config,
						withRequestId(config, {
							_tag: "EngineDefect",
							message: `No decoded input for ${event.toolCallId}`,
						}),
					);
				}
				return Effect.gen(function* () {
					yield* emit({
						_tag: "ToolInputReady",
						toolCallId: acc.toolCallId,
						providerToolCallId: acc.providerToolCallId,
					});
					yield* executeTool(acc.toolCallId, acc.providerToolCallId, acc.toolName, acc.toolKey, parser.decoded);
				});
			}

			case "stream_end": {
				return Effect.gen(function* () {
					const outcome = terminalToOutcome(event.terminal);
					const usage =
						event.terminal._tag === "StreamCompleted" && event.terminal.usage._tag === "UsageReported"
							? event.terminal.usage.usage
							: null;
					yield* emit({ _tag: "TurnEnd", outcome, usage });
				});
			}
			default: {
				const _exhaustive: never = event;
				return _exhaustive as unknown as Effect.Effect<void>;
			}
		}
	}

	// Run the stream, catch TurnAbort and convert to TurnEnd
	return Effect.fn("dispatcher.run")(function* () {
		yield* Stream.runForEach(config.events, processEvent).pipe(
			Effect.catchTag("TurnAbort", (abort) => emit({ _tag: "TurnEnd", outcome: abort.outcome, usage: null })),
			Effect.catchAllCause((cause) => {
				if (Cause.isInterrupted(cause)) {
					return emit({
						_tag: "TurnEnd",
						outcome: withRequestId(config, { _tag: "Interrupted" }),
						usage: null,
					});
				}
				const message = `Harness dispatcher defect\n${Cause.pretty(cause)}`;
				return Effect.logError("[harness] Dispatcher defect", { message, cause: Cause.pretty(cause) }).pipe(
					Effect.zipRight(
						emit({
							_tag: "TurnEnd",
							outcome: withRequestId(config, { _tag: "EngineDefect", message }),
							usage: null,
						}),
					),
				);
			}),
		);

		// The harness runtime layer is provided at the call-site boundary
		// (see harness.ts); per Effect-TS skills, layers are provided once at the
		// edge rather than re-provided inside the dispatcher.
	})();
}

// ── Helpers ──────────────────────────────────────────────────────

function formatStreamFailureMessage(cause: unknown): string {
	if (typeof cause === "object" && cause !== null && "message" in cause) {
		return String((cause as { message: unknown }).message);
	}
	return String(cause);
}
