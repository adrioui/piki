/**
 * Model definition factory.
 */

import { Clock, Effect, Option, Stream } from "effect";
import { snapshotModelAttemptFailure } from "../errors/classify.ts";
import { causeInfoText, StreamStartClientCorrectnessViolation, toCauseInfo } from "../errors/failure.ts";
import { normalizeVision } from "../prompt/normalize-vision.ts";
import { TraceListener } from "../trace.ts";
import { executeHttpStream } from "../transport/stream.ts";

export function joinUrl(endpoint: string, path: string): string {
	return endpoint.replace(/\/+$/, "") + path;
}

export interface DecodeOptions {
	tools: Array<{ name: string; inputSchema: unknown }> | undefined;
	streamContext: {
		responseHeaders: Headers;
		call: { method: string; url: string; provider: string; model: string };
		response: { status: number; headers: Array<[string, string]>; requestId: string | null; traceId: string | null };
	};
	generateToolCallId: () => string;
	toStreamFailure: (err: unknown) => unknown;
}

export function makeDecodeOptions(
	httpResult: {
		responseHeaders: Headers;
		call: { method: string; url: string; provider: string; model: string };
		response: { status: number; headers: Array<[string, string]>; requestId: string | null; traceId: string | null };
	},
	tools: Array<{ name: string; inputSchema: unknown }> | undefined,
	generateToolCallId: () => string,
): DecodeOptions {
	return {
		tools,
		streamContext: {
			responseHeaders: httpResult.responseHeaders,
			call: httpResult.call,
			response: httpResult.response,
		},
		generateToolCallId,
		toStreamFailure: (err) => err,
	};
}

export interface ModelCapabilities {
	vision?: boolean;
	grammar?: boolean;
}

export interface ModelSpec {
	modelId: string;
	endpoint: string;
	capabilities: ModelCapabilities | undefined;
	bind: (args: {
		auth: (headers: Headers) => void;
		defaults: Record<string, unknown>;
		imagePlaceholders?: { enabled: boolean; format: (part: unknown) => string };
	}) => {
		spec: ModelSpec;
		stream: (
			prompt: unknown,
			tools: unknown,
			callOptions: Record<string, unknown>,
		) => Effect.Effect<unknown, unknown, unknown>;
	};
	_execute: (
		auth: (headers: Headers) => void,
		prompt: unknown,
		tools: unknown,
		options: Record<string, unknown>,
	) => Effect.Effect<unknown, unknown, unknown>;
}

export function modelDefine(config: {
	modelId: string;
	endpoint: string;
	path: string;
	codec: {
		decode: (
			stream: Stream.Stream<unknown, any, any>,
			options: DecodeOptions,
		) => { events: Stream.Stream<unknown>; parsers: Map<string, unknown>; logprobs: unknown[] };
	};
	doneSignal: string;
	decodePayload: (raw: string) => Effect.Effect<unknown, unknown>;
	classifyRejectedResponse?: unknown;
	capabilities?: ModelCapabilities;
	buildWireRequest: (prompt: unknown, tools: unknown, options: Record<string, unknown>) => unknown;
}): ModelSpec {
	const url = joinUrl(config.endpoint, config.path);
	const call = {
		provider: config.endpoint,
		model: config.modelId,
		method: "POST" as const,
		url,
	};
	const spec: ModelSpec = {
		modelId: config.modelId,
		endpoint: config.endpoint,
		capabilities: config.capabilities,
		bind: (args) => modelBind(spec, args.auth, args.defaults, { imagePlaceholders: args.imagePlaceholders }),
		_execute: (auth, prompt, tools, options) =>
			Effect.gen(function* () {
				const listenerOption = yield* Effect.serviceOption(TraceListener);
				const runtimeOptions = options;
				const wireRequest = yield* Effect.try({
					try: () => config.buildWireRequest(prompt, tools, options),
					catch: (cause) => {
						const causeInfo = toCauseInfo(cause);
						return new StreamStartClientCorrectnessViolation({
							call,
							component: "request_builder",
							message: `Could not build model request: ${causeInfoText(causeInfo)}`,
							evidence: { _tag: "UnexpectedDefectCaught", cause: causeInfo },
						});
					},
				});
				const httpEffect = executeHttpStream({
					call,
					body: wireRequest,
					auth,
					decodePayload: config.decodePayload,
					doneSignal: config.doneSignal,
					classifyRejectedResponse: config.classifyRejectedResponse as
						| ((call: unknown, response: unknown) => Effect.Effect<never>)
						| undefined,
				});
				if (Option.isNone(listenerOption)) {
					return (yield* httpEffect.pipe(
						Effect.map((httpResult) => ({
							...config.codec.decode(
								httpResult.stream,
								makeDecodeOptions(
									httpResult,
									tools as never,
									(runtimeOptions as { generateToolCallId: () => string }).generateToolCallId,
								),
							),
							requestId: httpResult.response.requestId,
						})),
					)) as unknown;
				}
				const listener = listenerOption.value;
				const startedAt = yield* Clock.currentTimeMillis;
				const startTime = performance.now();
				let reasoning = "";
				let text = "";
				const toolCallMap = new Map<
					string,
					{ id: string; providerToolCallId: string; name: string; args: Record<string, unknown> }
				>();
				let finishReason: string | null = null;
				let usage: unknown = null;
				let rawInput: unknown[] | null = null;
				let rawOutput: unknown[] | null = null;
				const result = yield* httpEffect.pipe(
					Effect.map((httpResult) => ({
						...config.codec.decode(
							httpResult.stream,
							makeDecodeOptions(
								httpResult,
								tools as never,
								(runtimeOptions as { generateToolCallId: () => string }).generateToolCallId,
							),
						),
						requestId: httpResult.response.requestId,
					})),
					Effect.mapError((failure) => {
						const trace = {
							modelId: config.modelId,
							url,
							startedAt,
							durationMs: performance.now() - startTime,
							request: wireRequest,
							response: {
								reasoning: null,
								text: null,
								toolCalls: [],
								finishReason: null,
								usage: null,
								logprobs: null,
							},
							...(rawInput ? { rawInput } : {}),
							...(rawOutput ? { rawOutput } : {}),
							modelAttemptFailure: snapshotModelAttemptFailure(
								failure as { _tag: string; [key: string]: unknown },
							),
						};
						listener.onTrace(trace);
						return failure;
					}),
				);
				const tracedEvents = (result as { events: Stream.Stream<unknown> }).events.pipe(
					Stream.tap((event) =>
						Effect.sync(() => {
							const e = event as { _tag: string; [key: string]: unknown };
							switch (e._tag) {
								case "thought_delta":
									reasoning += e.text as string;
									break;
								case "message_delta":
									text += e.text as string;
									break;
								case "tool_call_start":
									toolCallMap.set(e.toolCallId as string, {
										id: e.toolCallId as string,
										providerToolCallId: e.providerToolCallId as string,
										name: e.toolName as string,
										args: {},
									});
									break;
								case "tool_call_field_end": {
									const tc = toolCallMap.get(e.toolCallId as string);
									if (tc) {
										const path = e.path as string[];
										if (path.length === 0) {
											tc.args = e.value as Record<string, unknown>;
										} else {
											let target = tc.args;
											for (let i = 0; i < path.length - 1; i++) {
												if (!(path[i] in target)) {
													target[path[i]] = {};
												}
												target = target[path[i]] as Record<string, unknown>;
											}
											target[path[path.length - 1]] = e.value;
										}
									}
									break;
								}
								case "stream_end": {
									const terminal = e.terminal as {
										_tag: string;
										finishReason?: string;
										usage?: { _tag: string; usage?: unknown };
									};
									if (terminal._tag === "StreamCompleted") {
										finishReason = terminal.finishReason ?? null;
										if (terminal.usage?._tag === "UsageReported") {
											usage = terminal.usage.usage;
										}
									}
									rawInput = (e.rawInput as unknown[]) ?? null;
									rawOutput = (e.rawOutput as unknown[]) ?? null;
									break;
								}
							}
						}),
					),
					Stream.ensuring(
						Effect.sync(() => {
							const assembledToolCalls = Array.from(toolCallMap.values()).map((tc) => ({
								id: tc.id,
								providerToolCallId: tc.providerToolCallId,
								name: tc.name,
								arguments: tc.args,
							}));
							const trace = {
								modelId: config.modelId,
								url,
								startedAt,
								durationMs: performance.now() - startTime,
								request: wireRequest,
								response: {
									reasoning: reasoning.length > 0 ? reasoning : null,
									text: text.length > 0 ? text : null,
									toolCalls: assembledToolCalls,
									finishReason,
									usage,
									logprobs:
										(result as { logprobs: unknown[] }).logprobs.length > 0
											? (result as { logprobs: unknown[] }).logprobs
											: null,
								},
								...(rawInput ? { rawInput } : {}),
								...(rawOutput ? { rawOutput } : {}),
							};
							listener.onTrace(trace);
						}),
					),
				);
				return {
					events: tracedEvents,
					parsers: (result as { parsers: Map<string, unknown> }).parsers,
					logprobs: (result as { logprobs: unknown[] }).logprobs,
					requestId: (result as { requestId: string | null }).requestId,
				};
			}),
	};
	return spec;
}

export function modelBind(
	spec: ModelSpec,
	auth: (headers: Headers) => void,
	defaults: Record<string, unknown>,
	options: { imagePlaceholders?: { enabled: boolean; format: (part: unknown) => string } },
) {
	return {
		spec,
		stream: (prompt: unknown, tools: unknown, callOptions: Record<string, unknown>) => {
			const merged = { ...defaults, ...callOptions };
			const normalizedPrompt =
				options?.imagePlaceholders?.enabled && spec.capabilities?.vision === false
					? normalizeVision(prompt as never, options.imagePlaceholders.format as never)
					: prompt;
			return spec._execute(auth, normalizedPrompt, tools, merged);
		},
	};
}
