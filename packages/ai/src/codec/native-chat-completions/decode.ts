/**
 * Native chat completions decoder.
 */

import type { Schema } from "effect";
import { Stream } from "effect";
import {
	ModelStreamTerminal,
	payloadSample,
	StreamOperationalFailure,
	StreamProviderCorrectnessViolation,
	StreamProviderError,
} from "../../errors/failure.ts";
import type { DecodeOptions } from "../../model/define.ts";
import { createToolCallId } from "../../prompt/ids.ts";
import { createStreamingFieldParser, type FieldEvent } from "../../streaming/field-parser.ts";
import type { ChatCompletionsStreamChunk } from "../../wire/chat-completions.ts";

function usageAtTermination(
	usage: unknown,
	reasonIfMissing: string,
): { _tag: "UsageNotReported"; reason: string } | { _tag: "UsageReported"; usage: unknown } {
	return usage === null ? { _tag: "UsageNotReported", reason: reasonIfMissing } : { _tag: "UsageReported", usage };
}

function buildTerminal(
	pending:
		| { _tag: "completed"; finishReason: string }
		| {
				_tag: "validation_failure";
				toolCallId: string;
				providerToolCallId: string;
				toolName: string;
				issue: { path: string[]; message: string } | null;
		  },
	call: { method: string; url: string; provider: string; model: string },
	response: { status: number; headers: Array<[string, string]>; requestId: string | null; traceId: string | null },
	progress: { dataPayloadsDecoded: number; modelEventsEmitted: number },
	usage: unknown,
) {
	const usageAt = usageAtTermination(usage, "usage_chunk_never_arrived");
	switch (pending._tag) {
		case "completed":
			return ModelStreamTerminal.StreamCompleted({
				call,
				response,
				finishReason: pending.finishReason,
				progress,
				usage: usageAt,
			});
		case "validation_failure":
			return ModelStreamTerminal.StreamFailed({
				cause: new StreamProviderCorrectnessViolation({
					call,
					response,
					violation: {
						_tag: "InvalidConstrainedOutput",
						output: {
							_tag: "InvalidToolInput",
							toolCallId: pending.toolCallId,
							providerToolCallId: pending.providerToolCallId,
							toolName: pending.toolName,
							issue: pending.issue,
						},
					},
					progress,
				}),
				usage: usageAt,
			});
	}
}

function makeTerminatedStreamTerminal(failure: unknown, usage: unknown) {
	const usageAt = usageAtTermination(usage, "stream_failed_before_usage");
	return ModelStreamTerminal.StreamFailed({
		cause: failure as never,
		usage: usageAt,
	});
}

type FinishingPending =
	| { _tag: "completed"; finishReason: string }
	| {
			_tag: "validation_failure";
			toolCallId: string;
			providerToolCallId: string;
			toolName: string;
			issue: { path: string[]; message: string } | null;
	  };

type PhaseState = { _tag: "streaming" } | { _tag: "finishing"; pending: FinishingPending } | { _tag: "done" };

interface DecoderState {
	thoughtOpen: boolean;
	messageOpen: boolean;
	openToolCalls: Map<
		number,
		{
			toolCallId: string;
			providerToolCallId: string;
			toolName: string;
			parser: ReturnType<typeof createStreamingFieldParser>;
		}
	>;
	toolSchemas: Map<string, Schema.Schema<unknown> | undefined>;
	phase: PhaseState;
	rawInput: unknown[] | null;
	rawOutput: unknown[] | null;
}

const INITIAL_PHASE: PhaseState = { _tag: "streaming" };

function makeInitialState(tools: Array<{ name: string; inputSchema: unknown }> | undefined): DecoderState {
	const toolSchemas = new Map<string, Schema.Schema<unknown> | undefined>();
	if (tools) {
		for (const tool of tools) {
			toolSchemas.set(tool.name, tool.inputSchema as Schema.Schema<unknown> | undefined);
		}
	}
	return {
		thoughtOpen: false,
		messageOpen: false,
		openToolCalls: new Map(),
		toolSchemas,
		phase: INITIAL_PHASE,
		rawInput: null,
		rawOutput: null,
	};
}

function toUsage(usage: {
	prompt_tokens: number;
	completion_tokens: number;
	prompt_tokens_details?: { cached_tokens?: number | null } | null;
	cost?: number;
}) {
	return {
		inputTokens: usage.prompt_tokens,
		outputTokens: usage.completion_tokens,
		cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
		cacheWriteTokens: 0,
		cost: usage.cost ?? null,
	};
}

function mapReason(reason: string): string {
	switch (reason) {
		case "stop":
		case "tool_calls":
		case "length":
		case "content_filter":
		case "end_turn":
			return reason;
		default:
			return "unknown";
	}
}

function wrapFieldEvents(fieldEvents: FieldEvent[], toolCallId: string, providerToolCallId: string) {
	return fieldEvents.map((fe) => {
		if (fe._tag === "field_start") {
			return { _tag: "tool_call_field_start" as const, toolCallId, providerToolCallId, path: fe.path };
		} else if (fe._tag === "field_delta") {
			return {
				_tag: "tool_call_field_delta" as const,
				toolCallId,
				providerToolCallId,
				path: fe.path,
				delta: fe.delta,
			};
		} else {
			return {
				_tag: "tool_call_field_end" as const,
				toolCallId,
				providerToolCallId,
				path: fe.path,
				value: fe.value,
			};
		}
	});
}

function decoderProgress(chunksObserved: number, modelEventsEmitted: number) {
	return { dataPayloadsDecoded: chunksObserved, modelEventsEmitted };
}

type DecoderEvent =
	| { _tag: "thought_start"; level: string }
	| { _tag: "thought_delta"; text: string }
	| { _tag: "thought_end" }
	| { _tag: "message_start" }
	| { _tag: "message_delta"; text: string }
	| { _tag: "message_end" }
	| { _tag: "tool_call_start"; toolCallId: string; providerToolCallId: string; toolName: string }
	| { _tag: "tool_call_field_start"; toolCallId: string; providerToolCallId: string; path: string[] }
	| { _tag: "tool_call_field_delta"; toolCallId: string; providerToolCallId: string; path: string[]; delta: string }
	| { _tag: "tool_call_field_end"; toolCallId: string; providerToolCallId: string; path: string[]; value: unknown }
	| { _tag: "tool_call_ready"; toolCallId: string; providerToolCallId: string }
	| {
			_tag: "stream_end";
			terminal: ReturnType<typeof ModelStreamTerminal.StreamCompleted | typeof ModelStreamTerminal.StreamFailed>;
			rawInput?: unknown[];
			rawOutput?: unknown[];
	  };

function processChunk(
	chunk: ChatCompletionsStreamChunk,
	state: DecoderState,
	parsers: Map<string, ReturnType<typeof createStreamingFieldParser>>,
	logprobs: unknown[],
	generateToolCallId: () => string,
	streamContext: DecodeOptions["streamContext"],
	progress: { dataPayloadsDecoded: number; modelEventsEmitted: number },
): [DecoderState, DecoderEvent[]] {
	const events: DecoderEvent[] = [];
	let nextState = state;
	if (nextState.phase._tag === "done") {
		return [nextState, events];
	}
	nextState = {
		...nextState,
		rawInput: (chunk.raw_input as unknown[] | null | undefined) ?? nextState.rawInput,
		rawOutput: (chunk.raw_output as unknown[] | null | undefined) ?? nextState.rawOutput,
	};
	if (chunk.error) {
		const error = chunk.error;
		const failure = new StreamProviderError({
			call: streamContext.call,
			response: streamContext.response,
			providerError: {
				message: error.message,
				type: error.type ?? null,
				code: error.code ?? null,
				param: error.param ?? null,
			},
			payload: payloadSample(JSON.stringify({ error })),
			progress,
		});
		events.push({
			_tag: "stream_end",
			terminal: makeTerminatedStreamTerminal(failure, null),
			rawInput: nextState.rawInput ?? undefined,
			rawOutput: nextState.rawOutput ?? undefined,
		});
		return [{ ...nextState, phase: { _tag: "done" } }, events];
	}
	if (chunk.usage) {
		if (nextState.phase._tag === "finishing") {
			const { pending } = nextState.phase;
			events.push({
				_tag: "stream_end",
				terminal: buildTerminal(
					pending,
					streamContext.call,
					streamContext.response,
					progress,
					toUsage(chunk.usage),
				),
				rawInput: nextState.rawInput ?? undefined,
				rawOutput: nextState.rawOutput ?? undefined,
			});
			return [{ ...nextState, phase: { _tag: "done" } }, events];
		}
	}
	if (nextState.phase._tag === "finishing") {
		return [nextState, events];
	}
	const choice = chunk.choices[0];
	if (!choice) {
		return [nextState, events];
	}
	if (choice.logprobs?.content) {
		for (const lp of choice.logprobs.content) {
			logprobs.push({
				token: lp.token,
				logprob: lp.logprob,
				topLogprobs: lp.top_logprobs.map((tp) => ({ token: tp.token, logprob: tp.logprob })),
			});
		}
	}
	const delta = choice.delta;
	if (delta.reasoning_content) {
		if (!nextState.thoughtOpen) {
			nextState = { ...nextState, thoughtOpen: true };
			events.push({ _tag: "thought_start", level: "medium" });
		}
		events.push({ _tag: "thought_delta", text: delta.reasoning_content });
	}
	if (delta.content) {
		if (nextState.thoughtOpen) {
			events.push({ _tag: "thought_end" });
			nextState = { ...nextState, thoughtOpen: false };
		}
		if (!nextState.messageOpen) {
			nextState = { ...nextState, messageOpen: true };
			events.push({ _tag: "message_start" });
		}
		events.push({ _tag: "message_delta", text: delta.content });
	}
	if (delta.tool_calls && delta.tool_calls.length > 0) {
		if (nextState.thoughtOpen) {
			events.push({ _tag: "thought_end" });
			nextState = { ...nextState, thoughtOpen: false };
		}
		if (nextState.messageOpen) {
			events.push({ _tag: "message_end" });
			nextState = { ...nextState, messageOpen: false };
		}
		const calls = new Map(nextState.openToolCalls);
		for (const toolCallDelta of delta.tool_calls) {
			let toolCall = calls.get(toolCallDelta.index);
			if (!toolCall) {
				for (const [idx, openCall] of calls.entries()) {
					if (idx < toolCallDelta.index) {
						const fieldEvents = openCall.parser.end();
						events.push(...wrapFieldEvents(fieldEvents, openCall.toolCallId, openCall.providerToolCallId));
						if (!openCall.parser.valid) {
							const pending = {
								_tag: "validation_failure" as const,
								toolCallId: openCall.toolCallId,
								providerToolCallId: openCall.providerToolCallId,
								toolName: openCall.toolName,
								issue: openCall.parser.validationIssue,
							};
							return [{ ...nextState, phase: { _tag: "finishing", pending }, openToolCalls: new Map() }, events];
						}
						events.push({
							_tag: "tool_call_ready",
							toolCallId: openCall.toolCallId,
							providerToolCallId: openCall.providerToolCallId,
						});
						calls.delete(idx);
					}
				}
				const name = toolCallDelta.function?.name ?? "";
				const schema = nextState.toolSchemas.get(name);
				const parser = schema ? createStreamingFieldParser(schema) : createStreamingFieldParser();
				const toolCallId = generateToolCallId();
				const providerToolCallId = toolCallDelta.id ?? toolCallId;
				toolCall = { toolCallId, providerToolCallId, toolName: name, parser };
				calls.set(toolCallDelta.index, toolCall);
				parsers.set(toolCallId, parser);
				events.push({
					_tag: "tool_call_start",
					toolCallId: toolCall.toolCallId,
					providerToolCallId: toolCall.providerToolCallId,
					toolName: toolCall.toolName,
				});
			} else if (toolCallDelta.function?.name && toolCall.toolName.length === 0) {
				const name = toolCallDelta.function.name;
				const schema = nextState.toolSchemas.get(name);
				const parser = schema ? createStreamingFieldParser(schema) : createStreamingFieldParser();
				toolCall = { ...toolCall, toolName: name, parser };
				calls.set(toolCallDelta.index, toolCall);
				parsers.set(toolCall.toolCallId, parser);
			}
			if (toolCallDelta.function?.arguments) {
				const fieldEvents = toolCall.parser.push(toolCallDelta.function.arguments);
				events.push(...wrapFieldEvents(fieldEvents, toolCall.toolCallId, toolCall.providerToolCallId));
			}
		}
		nextState = { ...nextState, openToolCalls: calls };
	}
	if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
		if (nextState.thoughtOpen) {
			events.push({ _tag: "thought_end" });
			nextState = { ...nextState, thoughtOpen: false };
		}
		if (nextState.messageOpen) {
			events.push({ _tag: "message_end" });
			nextState = { ...nextState, messageOpen: false };
		}
		for (const toolCall of nextState.openToolCalls.values()) {
			const fieldEvents = toolCall.parser.end();
			events.push(...wrapFieldEvents(fieldEvents, toolCall.toolCallId, toolCall.providerToolCallId));
			if (!toolCall.parser.valid) {
				const pending = {
					_tag: "validation_failure" as const,
					toolCallId: toolCall.toolCallId,
					providerToolCallId: toolCall.providerToolCallId,
					toolName: toolCall.toolName,
					issue: toolCall.parser.validationIssue,
				};
				if (chunk.usage) {
					events.push({
						_tag: "stream_end",
						terminal: buildTerminal(
							pending,
							streamContext.call,
							streamContext.response,
							progress,
							toUsage(chunk.usage),
						),
						rawInput: nextState.rawInput ?? undefined,
						rawOutput: nextState.rawOutput ?? undefined,
					});
					return [{ ...nextState, phase: { _tag: "done" }, openToolCalls: new Map() }, events];
				}
				return [{ ...nextState, phase: { _tag: "finishing", pending }, openToolCalls: new Map() }, events];
			}
			events.push({
				_tag: "tool_call_ready",
				toolCallId: toolCall.toolCallId,
				providerToolCallId: toolCall.providerToolCallId,
			});
		}
		const finishReason = mapReason(choice.finish_reason);
		if (chunk.usage) {
			nextState = {
				...nextState,
				rawInput: (chunk.raw_input as unknown[] | null | undefined) ?? nextState.rawInput,
				rawOutput: (chunk.raw_output as unknown[] | null | undefined) ?? nextState.rawOutput,
			};
			events.push({
				_tag: "stream_end",
				terminal: buildTerminal(
					{ _tag: "completed", finishReason },
					streamContext.call,
					streamContext.response,
					progress,
					toUsage(chunk.usage),
				),
				rawInput: nextState.rawInput ?? undefined,
				rawOutput: nextState.rawOutput ?? undefined,
			});
			nextState = { ...nextState, openToolCalls: new Map(), phase: { _tag: "done" } };
		} else {
			nextState = {
				...nextState,
				openToolCalls: new Map(),
				phase: { _tag: "finishing", pending: { _tag: "completed", finishReason } },
			};
		}
	}
	return [nextState, events];
}

export function decode(chunks: Stream.Stream<ChatCompletionsStreamChunk>, options: DecodeOptions) {
	const generateToolCallId = options.generateToolCallId ?? createToolCallId;
	const parsers = new Map<string, ReturnType<typeof createStreamingFieldParser>>();
	const logprobs: unknown[] = [];
	let chunksObserved = 0;
	let modelEventsEmitted = 0;
	let lastState = makeInitialState(options.tools);
	const tracked = Stream.mapAccum(chunks, makeInitialState(options.tools), (state, chunk) => {
		chunksObserved += 1;
		const result = processChunk(
			chunk,
			state,
			parsers,
			logprobs,
			generateToolCallId,
			options.streamContext,
			decoderProgress(chunksObserved, modelEventsEmitted),
		);
		lastState = result[0];
		modelEventsEmitted += result[1].length;
		return result;
	});
	const flattened = Stream.flatMap(tracked, (events) => Stream.fromIterable(events));
	const raw = Stream.concat(
		flattened,
		Stream.suspend(() => {
			if (lastState.phase._tag === "finishing") {
				const endEvent = {
					_tag: "stream_end" as const,
					terminal: buildTerminal(
						lastState.phase.pending,
						options.streamContext.call,
						options.streamContext.response,
						decoderProgress(chunksObserved, modelEventsEmitted),
						null,
					),
					rawInput: lastState.rawInput ?? undefined,
					rawOutput: lastState.rawOutput ?? undefined,
				};
				return Stream.make(endEvent);
			}
			if (lastState.phase._tag === "streaming") {
				const failure = new StreamOperationalFailure({
					call: options.streamContext.call,
					response: options.streamContext.response,
					reason: {
						_tag: "ConnectionClosedWithoutTerminalOutcome",
						expectation: chunksObserved === 0 ? { _tag: "InitialChunk" } : { _tag: "FinishReasonOrMoreChunks" },
					},
					progress: decoderProgress(chunksObserved, modelEventsEmitted),
				});
				const endEvent = {
					_tag: "stream_end" as const,
					terminal: makeTerminatedStreamTerminal(failure, null),
					rawInput: lastState.rawInput ?? undefined,
					rawOutput: lastState.rawOutput ?? undefined,
				};
				return Stream.make(endEvent);
			}
			return Stream.empty;
		}),
	);
	const withErrorHandling = Stream.catchAll(raw, (error) => {
		const streamFailure = options.toStreamFailure(error);
		const endEvent = {
			_tag: "stream_end" as const,
			terminal: makeTerminatedStreamTerminal(streamFailure, null),
			rawInput: lastState.rawInput ?? undefined,
			rawOutput: lastState.rawOutput ?? undefined,
		};
		return Stream.make(endEvent);
	});
	const events = Stream.takeUntil(withErrorHandling, (event) => event._tag === "stream_end");
	return { events, parsers, logprobs };
}
