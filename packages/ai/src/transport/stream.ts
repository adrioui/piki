/**
 * HTTP streaming transport for model inference.
 */

import { HttpClient } from "@effect/platform";
import * as HttpBody from "@effect/platform/HttpBody";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import { Clock, Duration, Effect, Stream } from "effect";
import { streamStartFailureFromRejectedResponse } from "../errors/classify.ts";
import {
	acceptedHttpResponse,
	causeInfoText,
	headersFromHeaderList,
	payloadSample,
	rejectedHttpResponse,
	StreamOperationalFailure,
	StreamProviderCorrectnessViolation,
	StreamStartClientCorrectnessViolation,
	StreamStartOperationalFailure,
	toCauseInfo,
} from "../errors/failure.ts";
import { sseStream } from "./sse.ts";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60000;

function toHeaderRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => {
		result[key] = value;
	});
	return result;
}

function progress(dataPayloadsDecoded: number) {
	return { dataPayloadsDecoded, modelEventsEmitted: 0 };
}

function bodyReadFailure(
	err: { reason?: unknown; cause?: unknown },
	call: { method: string; url: string; provider: string; model: string },
	response: { status: number; headers: Array<[string, string]>; requestId: string | null; traceId: string | null },
	dataPayloadsDecoded: number,
) {
	return new StreamOperationalFailure({
		call,
		response,
		reason: {
			_tag: "BodyReadFailure",
			readError: {
				_tag: "EffectResponseBodyError",
				effectReason: err.reason,
				cause: toCauseInfo(err.cause ?? err),
			},
		},
		progress: progress(dataPayloadsDecoded),
	});
}

function chunkDecodeFailure(
	raw: string,
	cause: unknown,
	call: { method: string; url: string; provider: string; model: string },
	response: { status: number; headers: Array<[string, string]>; requestId: string | null; traceId: string | null },
	dataPayloadsDecoded: number,
) {
	const sample = payloadSample(raw);
	const message = causeMessage(cause);
	if (isJsonParseCause(cause)) {
		return new StreamProviderCorrectnessViolation({
			call,
			response,
			violation: {
				_tag: "InvalidProviderChunk",
				problem: {
					_tag: "InvalidJson",
					payload: sample,
					cause: toCauseInfo(cause),
				},
			},
			progress: progress(dataPayloadsDecoded),
		});
	}
	return new StreamProviderCorrectnessViolation({
		call,
		response,
		violation: {
			_tag: "InvalidProviderChunk",
			problem: {
				_tag: "InvalidChunkSchema",
				payload: sample,
				issue: { message },
				cause: toCauseInfo(cause),
			},
		},
		progress: progress(dataPayloadsDecoded),
	});
}

function isJsonParseCause(cause: unknown): boolean {
	return (
		typeof cause === "object" &&
		cause !== null &&
		"_tag" in cause &&
		(cause as { _tag: string })._tag === "ChatPayloadJsonParseError"
	);
}

function causeMessage(cause: unknown): string {
	if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
	if (typeof cause === "object" && cause !== null && "message" in cause) {
		const message = (cause as { message: unknown }).message;
		if (typeof message === "string" && message.trim().length > 0) return message;
	}
	return String(cause);
}

export interface ExecuteHttpStreamConfig<TDecoded> {
	call: { method: string; url: string; provider: string; model: string };
	body: unknown;
	auth: (headers: Headers) => void;
	decodePayload: (raw: string) => Effect.Effect<TDecoded, unknown>;
	doneSignal?: string;
	classifyRejectedResponse?: (
		call: { method: string; url: string; provider: string; model: string },
		response: ReturnType<typeof rejectedHttpResponse>,
	) => Effect.Effect<never>;
	idleTimeoutMs?: number;
	extraHeaders?: Record<string, string>;
}

export function executeHttpStream<TDecoded>(config: ExecuteHttpStreamConfig<TDecoded>) {
	return Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const headers = new Headers();
		headers.set("Content-Type", "application/json");
		headers.set("Accept", "text/event-stream");
		if (config.extraHeaders) {
			for (const [k, v] of Object.entries(config.extraHeaders)) {
				headers.set(k, v);
			}
		}
		yield* Effect.try({
			try: () => config.auth(headers),
			catch: (cause) => {
				const causeInfo = toCauseInfo(cause);
				return new StreamStartClientCorrectnessViolation({
					call: config.call,
					component: "auth_applicator",
					message: `Could not apply model authentication: ${causeInfoText(causeInfo)}`,
					evidence: { _tag: "AuthApplicationFailed", cause: causeInfo },
				});
			},
		});
		const request = yield* Effect.try({
			try: () =>
				HttpClientRequest.post(config.call.url).pipe(
					HttpClientRequest.setHeaders(toHeaderRecord(headers)),
					HttpClientRequest.setBody(HttpBody.unsafeJson(config.body)),
				),
			catch: (cause) => {
				const causeInfo = toCauseInfo(cause);
				return new StreamStartClientCorrectnessViolation({
					call: config.call,
					component: "request_body_encoder",
					message: `Could not encode model request body: ${causeInfoText(causeInfo)}`,
					evidence: { _tag: "RequestBodyEncodingFailed", cause: causeInfo },
				});
			},
		});
		const rawResponse = yield* client.execute(request).pipe(
			Effect.mapError(
				(err) =>
					new StreamStartOperationalFailure({
						call: config.call,
						reason: { _tag: "RequestFailedBeforeResponse", cause: toCauseInfo(err) },
					}),
			),
		);
		if (rawResponse.status < 200 || rawResponse.status >= 300) {
			const body = yield* rawResponse.text.pipe(Effect.orElseSucceed(() => ""));
			const classifyRejectedResponse = config.classifyRejectedResponse ?? streamStartFailureFromRejectedResponse;
			return yield* classifyRejectedResponse(
				config.call,
				rejectedHttpResponse(rawResponse.status, rawResponse.headers, body),
			);
		}
		const response = acceptedHttpResponse(rawResponse.status, rawResponse.headers);
		const responseHeaders = headersFromHeaderList(response.headers);
		let dataPayloadsDecoded = 0;
		let lastActivity: { _tag: string; atEpochMs?: number } = { _tag: "NoActivity" };
		const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
		const now = yield* Clock.currentTimeMillis;
		lastActivity = { _tag: "ResponseAccepted", atEpochMs: now };
		const byteStream = rawResponse.stream.pipe(
			Stream.tap(() =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					lastActivity = { _tag: "BodyBytesRead", atEpochMs: now };
				}),
			),
			Stream.tapError((err) =>
				Effect.logError("[stream] Response body read failure", {
					failure: bodyReadFailure(err, config.call, response, dataPayloadsDecoded),
				}),
			),
			Stream.mapError((err) => bodyReadFailure(err, config.call, response, dataPayloadsDecoded)),
			Stream.timeoutFail(
				() =>
					new StreamOperationalFailure({
						call: config.call,
						response,
						reason: { _tag: "StallTimeout", timeoutMs: idleTimeoutMs, lastActivity },
						progress: progress(dataPayloadsDecoded),
					}),
				Duration.millis(idleTimeoutMs),
			),
		);
		const wrappedDecode = (raw: string) =>
			Stream.fromEffect(
				config.decodePayload(raw).pipe(
					Effect.tap(() =>
						Effect.gen(function* () {
							dataPayloadsDecoded += 1;
							const now = yield* Clock.currentTimeMillis;
							lastActivity = { _tag: "DataPayloadDecoded", atEpochMs: now };
						}),
					),
					Effect.tapError((cause) =>
						Effect.logError("[stream] Chunk decode failure", { payload: raw, error: String(cause) }),
					),
					Effect.mapError((cause) => chunkDecodeFailure(raw, cause, config.call, response, dataPayloadsDecoded)),
				),
			);
		return {
			stream: sseStream(byteStream, wrappedDecode, config.doneSignal),
			responseHeaders,
			call: config.call,
			response,
		};
	});
}
