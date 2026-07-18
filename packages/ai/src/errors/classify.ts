/**
 * Error envelope parsing, classification, and formatting.
 */

import {
	causeInfoText,
	payloadSample,
	type rejectedHttpResponse,
	StreamStartProviderCorrectnessViolation,
	StreamStartProviderRejection,
	toCauseInfo,
} from "./failure.ts";

function _cast<T>(value: unknown): T {
	return value as T;
}

export function hasPattern(text: string, patterns: string[]): boolean {
	return patterns.some((pattern) => text.includes(pattern));
}

export function tryParseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {}
	let offset = 0;
	while (true) {
		offset = text.indexOf("{", offset);
		if (offset === -1) break;
		try {
			const parsed = JSON.parse(text.slice(offset));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {}
		offset += 1;
	}
	return null;
}

export function getNestedErrorObject(text: string): Record<string, unknown> | null {
	const parsed = tryParseJsonObject(text);
	const error = parsed?.error;
	return error && typeof error === "object" && !Array.isArray(error) ? (error as Record<string, unknown>) : null;
}

export function providerErrorEnvelopeFromBody(body: string) {
	const error = getNestedErrorObject(body);
	if (error === null) return null;
	const message = error.message;
	if (typeof message !== "string" || message.trim().length === 0) return null;
	const type = error.type;
	const code = error.code;
	const param = error.param;
	return {
		message,
		type: typeof type === "string" ? type : null,
		code: typeof code === "string" ? code : null,
		param: typeof param === "string" ? param : null,
	};
}

export function notRetryable(reason: string) {
	return { _tag: "NotRetryable" as const, reason };
}

export function retryable(retryAfterMs: number | null) {
	return { _tag: "Retryable" as const, retryAfterMs };
}

function providerErrorText(error: {
	message: string;
	type: string | null;
	code: string | null;
	param: string | null;
}): string {
	return [error.message, error.type ?? "", error.code ?? "", error.param ?? ""].join(" ").toLowerCase();
}

function providerErrorRetryable(
	error: { message: string; type: string | null; code: string | null; param: string | null },
	status: number,
): boolean {
	const text = providerErrorText(error);
	// Only 429 and 5xx responses are retryable. Transient-pattern matching is
	// intentionally NOT applied to 4xx responses (e.g. 409) — matching
	// Magnitude's behavior, where any 4xx except 429 is a non-retryable
	// invalid_request. Connection/operational failures are retried separately
	// via the StreamOperationalFailure path.
	if (status === 429 || status >= 500) {
		return !hasPattern(text, CONTEXT_LIMIT_PATTERNS);
	}
	return false;
}

export function defaultProviderRejection(
	envelope: { message: string; type: string | null; code: string | null; param: string | null },
	response: { status: number; retryAfterMs: number | null },
) {
	const text = providerErrorText(envelope);
	if (
		response.status === 401 ||
		response.status === 403 ||
		hasPattern(text, [
			"missing_scope",
			"insufficient_scope",
			"invalid_token",
			"token expired",
			"expired token",
			"unauthorized",
			"forbidden",
			"authentication",
			"invalid_api_key",
		])
	) {
		return {
			_tag: "AuthenticationRejected" as const,
			status: response.status,
			message: envelope.message,
			retry: notRetryable("auth"),
		};
	}
	if (hasPattern(text, CONTEXT_LIMIT_PATTERNS)) {
		return {
			_tag: "ContextLimitExceeded" as const,
			status: response.status,
			message: envelope.message,
			retry: notRetryable("context_limit"),
		};
	}
	if (response.status === 429) {
		return {
			_tag: "RateLimited" as const,
			status: response.status,
			message: envelope.message,
			retryAfterMs: response.retryAfterMs,
			retry: retryable(response.retryAfterMs),
		};
	}
	if (response.status >= 400 && response.status < 500) {
		return {
			_tag: "InvalidRequest" as const,
			status: response.status,
			message: envelope.message,
			retry: notRetryable("invalid_request"),
		};
	}
	return {
		_tag: "ProviderFailure" as const,
		status: response.status,
		message: envelope.message,
		retry:
			response.status >= 500 || hasPattern(text, TRANSIENT_PROVIDER_PATTERNS)
				? retryable(null)
				: notRetryable("provider_error_not_retryable"),
	};
}

export function streamStartFailureFromRejectedResponse(
	call: { method: string; url: string; provider: string; model: string },
	response: ReturnType<typeof rejectedHttpResponse>,
) {
	const providerError = providerErrorEnvelopeFromBody(response.body);
	if (providerError !== null) {
		return new StreamStartProviderRejection({
			call,
			response,
			rejection: defaultProviderRejection(providerError, response),
		});
	}
	return new StreamStartProviderCorrectnessViolation({
		call,
		response,
		violation: {
			_tag: "InvalidErrorEnvelope",
			status: response.status,
			body: payloadSample(response.body),
			issue: { message: "Rejected response body did not contain a valid error envelope" },
		},
	});
}

function formatStreamStartProviderViolation(violation: {
	_tag: string;
	status?: number;
	issue?: { message: string };
	field?: string;
}): string {
	switch (violation._tag) {
		case "InvalidErrorEnvelope":
			return `InvalidErrorEnvelope status=${violation.status} issue=${violation.issue?.message}`;
		case "MissingRequiredResponseMetadata":
			return `MissingRequiredResponseMetadata field=${violation.field} status=${violation.status}`;
		case "UnexpectedResponseShape":
			return `UnexpectedResponseShape status=${violation.status} issue=${violation.issue?.message}`;
		default:
			return `${violation._tag}`;
	}
}

function formatStreamStartClientCorrectnessEvidence(evidence: { _tag: string; cause: unknown }): string {
	return `${evidence._tag}: ${causeInfoText(toCauseInfo(evidence.cause))}`;
}

function formatLastActivity(activity: { _tag: string; atEpochMs?: number }): string {
	switch (activity._tag) {
		case "NoActivity":
			return "none";
		case "ResponseAccepted":
			return `response accepted at ${activity.atEpochMs}ms epoch`;
		case "BodyBytesRead":
			return `body bytes read at ${activity.atEpochMs}ms epoch`;
		case "DataPayloadDecoded":
			return `data payload decoded at ${activity.atEpochMs}ms epoch`;
		default:
			return `${activity._tag}`;
	}
}

function formatDecoderExpectation(expectation: { _tag: string; pendingReason?: string }): string {
	switch (expectation._tag) {
		case "InitialChunk":
			return "initial chunk";
		case "FinishReasonOrMoreChunks":
			return "finish reason or more chunks";
		case "UsageChunk":
			return `usage chunk after ${expectation.pendingReason}`;
		default:
			return `${expectation._tag}`;
	}
}

function formatStreamOperationalReason(reason: { _tag: string; [key: string]: unknown }): string {
	switch (reason._tag) {
		case "BodyReadFailure":
			return [
				"BodyReadFailure",
				(reason as unknown as { readError: { _tag: string; effectReason?: string } }).readError._tag ===
				"EffectResponseBodyError"
					? `effectReason=${(reason as unknown as { readError: { effectReason?: string } }).readError.effectReason}`
					: "reader=ReadableStream",
				`cause=${causeInfoText(toCauseInfo((reason as unknown as { readError: { cause: unknown } }).readError.cause))}`,
			].join(" ");
		case "StallTimeout":
			return `StallTimeout timeoutMs=${(reason as unknown as { timeoutMs: number }).timeoutMs} lastActivity=${formatLastActivity((reason as unknown as { lastActivity: { _tag: string; atEpochMs?: number } }).lastActivity)}`;
		case "ConnectionClosedWithoutTerminalOutcome":
			return `ConnectionClosedWithoutTerminalOutcome expected=${formatDecoderExpectation((reason as unknown as { expectation: { _tag: string; pendingReason?: string } }).expectation)}`;
		default:
			return `${reason._tag}`;
	}
}

function formatStreamProviderViolation(violation: { _tag: string; [key: string]: unknown }): string {
	switch (violation._tag) {
		case "SignaledDoneWithoutTerminalOutcome":
			return `SignaledDoneWithoutTerminalOutcome expected=${formatDecoderExpectation((violation as unknown as { expectation: { _tag: string; pendingReason?: string } }).expectation)}`;
		case "InvalidProviderChunk": {
			const problem = violation.problem as {
				_tag: string;
				cause?: unknown;
				payload?: { text: string };
				issue?: { message: string };
			};
			switch (problem._tag) {
				case "InvalidJson":
					return `InvalidProviderChunk problem=InvalidJson cause=${causeInfoText(toCauseInfo(problem.cause))} payload=${problem.payload?.text}`;
				case "InvalidChunkSchema":
					return `InvalidProviderChunk problem=InvalidChunkSchema issue=${problem.issue?.message} cause=${causeInfoText(toCauseInfo(problem.cause))} payload=${problem.payload?.text}`;
				default:
					return `InvalidProviderChunk problem=${problem._tag}`;
			}
		}
		case "InvalidConstrainedOutput": {
			const output = violation.output as { _tag: string; toolName: string; issue: { message: string } };
			return `InvalidConstrainedOutput output=${output._tag} tool=${output.toolName} issue=${output.issue.message}`;
		}
		default:
			return `${violation._tag}`;
	}
}

function formatStreamClientCorrectnessEvidence(evidence: { _tag: string; [key: string]: unknown }): string {
	switch (evidence._tag) {
		case "InvariantViolated":
			return `invariant violated: ${evidence.invariant}`;
		case "UnexpectedDefectCaught":
			return causeInfoText(toCauseInfo(evidence.cause));
		default:
			return `${evidence._tag}`;
	}
}

export function formatStreamStartFailureMessage(failure: { _tag: string; [key: string]: unknown }): string {
	switch (failure._tag) {
		case "StreamStartOperationalFailure": {
			const f = failure as unknown as {
				call: { method: string; url: string };
				reason: { _tag: string; cause: unknown };
			};
			return [
				"Model request failed before any response was accepted",
				`request: ${f.call.method} ${f.call.url}`,
				`reason: ${f.reason._tag}`,
				`cause: ${causeInfoText(toCauseInfo(f.reason.cause))}`,
			].join("\n");
		}
		case "StreamStartProviderRejection": {
			const f = failure as unknown as {
				response: { status: number };
				call: { method: string; url: string };
				rejection: { _tag: string; message: string };
			};
			return [
				"Model provider rejected the request",
				`response: ${f.response.status} ${f.call.method} ${f.call.url}`,
				`rejection: ${f.rejection._tag}`,
				`message: ${f.rejection.message}`,
			].join("\n");
		}
		case "StreamStartProviderCorrectnessViolation": {
			const f = failure as unknown as {
				response?: { status: number };
				call: { method: string; url: string };
				violation: { _tag: string; status?: number; issue?: { message: string }; field?: string };
			};
			return [
				"Model provider rejected the request with an invalid error response",
				`response: ${f.response?.status ?? "unavailable"} ${f.call.method} ${f.call.url}`,
				`violation: ${formatStreamStartProviderViolation(f.violation)}`,
			].join("\n");
		}
		case "StreamStartClientCorrectnessViolation": {
			const f = failure as unknown as {
				component: string;
				message: string;
				evidence: { _tag: string; cause: unknown };
			};
			return [
				"Stream-start client correctness violation",
				`component: ${f.component}`,
				`message: ${f.message}`,
				`evidence: ${formatStreamStartClientCorrectnessEvidence(f.evidence)}`,
			].join("\n");
		}
		default:
			return `${failure._tag}`;
	}
}

export function formatStreamFailureMessage(failure: { _tag: string; [key: string]: unknown }): string {
	switch (failure._tag) {
		case "StreamOperationalFailure": {
			const f = failure as unknown as {
				response: { status: number };
				call: { method: string; url: string };
				reason: { _tag: string; [key: string]: unknown };
			};
			return [
				"Model response stream failed operationally",
				`response: ${f.response.status} ${f.call.method} ${f.call.url}`,
				`reason: ${formatStreamOperationalReason(f.reason)}`,
			].join("\n");
		}
		case "StreamProviderError": {
			const f = failure as unknown as {
				response: { status: number };
				call: { method: string; url: string };
				providerError: { message: string; type: string | null; code: string | null; param: string | null };
			};
			return [
				"Model stream ended with provider error envelope",
				`response: ${f.response.status} ${f.call.method} ${f.call.url}`,
				`message: ${f.providerError.message}`,
				...(f.providerError.type !== null ? [`type: ${f.providerError.type}`] : []),
				...(f.providerError.code !== null ? [`code: ${f.providerError.code}`] : []),
				...(f.providerError.param !== null ? [`param: ${f.providerError.param}`] : []),
			].join("\n");
		}
		case "StreamProviderCorrectnessViolation": {
			const f = failure as unknown as {
				response: { status: number };
				call: { method: string; url: string };
				violation: { _tag: string; [key: string]: unknown };
			};
			return [
				"Model provider violated the stream/output contract",
				`response: ${f.response.status} ${f.call.method} ${f.call.url}`,
				`violation: ${formatStreamProviderViolation(f.violation)}`,
			].join("\n");
		}
		case "StreamClientCorrectnessViolation": {
			const f = failure as unknown as {
				component: string;
				message: string;
				evidence: { _tag: string; [key: string]: unknown };
			};
			return [
				"Stream client correctness violation",
				`component: ${f.component}`,
				`message: ${f.message}`,
				`evidence: ${formatStreamClientCorrectnessEvidence(f.evidence)}`,
			].join("\n");
		}
		default:
			return `${failure._tag}`;
	}
}

export function formatModelAttemptFailureMessage(failure: { _tag: string; [key: string]: unknown }): string {
	return failure._tag.startsWith("StreamStart")
		? formatStreamStartFailureMessage(failure)
		: formatStreamFailureMessage(failure);
}

function traceRef(failure: { _tag: string; [key: string]: unknown }) {
	if (!("response" in failure) || (failure as unknown as { response: unknown }).response === null) {
		return { _tag: "TraceUnavailable" as const, reason: "not_applicable" };
	}
	const response = (failure as unknown as { response: { traceId: string | null } }).response;
	return response.traceId === null
		? { _tag: "TraceUnavailable" as const, reason: "not_reported" }
		: { _tag: "TraceKnown" as const, value: response.traceId };
}

function detailTag(failure: { _tag: string; [key: string]: unknown }): string {
	switch (failure._tag) {
		case "StreamStartOperationalFailure":
			return (failure as unknown as { reason: { _tag: string } }).reason._tag;
		case "StreamStartProviderRejection":
			return (failure as unknown as { rejection: { _tag: string } }).rejection._tag;
		case "StreamStartProviderCorrectnessViolation":
			return (failure as unknown as { violation: { _tag: string } }).violation._tag;
		case "StreamStartClientCorrectnessViolation":
			return (failure as unknown as { evidence: { _tag: string } }).evidence._tag;
		case "StreamOperationalFailure":
			return (failure as unknown as { reason: { _tag: string } }).reason._tag;
		case "StreamProviderError":
			return (
				(failure as unknown as { providerError: { code: string | null; type: string | null } }).providerError
					.code ??
				(failure as unknown as { providerError: { code: string | null; type: string | null } }).providerError
					.type ??
				"ProviderError"
			);
		case "StreamProviderCorrectnessViolation":
			return streamProviderViolationDetailTag(
				(failure as unknown as { violation: { _tag: string; [key: string]: unknown } }).violation,
			);
		case "StreamClientCorrectnessViolation":
			return (failure as unknown as { evidence: { _tag: string } }).evidence._tag;
		default:
			return failure._tag;
	}
}

function streamProviderViolationDetailTag(violation: { _tag: string; [key: string]: unknown }): string {
	switch (violation._tag) {
		case "InvalidProviderChunk":
			return `${violation._tag}.${(violation as unknown as { problem: { _tag: string } }).problem._tag}`;
		case "InvalidConstrainedOutput":
			return `${violation._tag}.${(violation as unknown as { output: { _tag: string } }).output._tag}`;
		case "SignaledDoneWithoutTerminalOutcome":
			return violation._tag;
		default:
			return violation._tag;
	}
}

function retryHintForSnapshot(failure: { _tag: string; [key: string]: unknown }) {
	switch (failure._tag) {
		case "StreamStartOperationalFailure":
		case "StreamOperationalFailure":
			return { retryable: true, retryAfterMs: null };
		case "StreamStartProviderRejection": {
			const retry = (failure as unknown as { rejection: { retry: { _tag: string; retryAfterMs?: number | null } } })
				.rejection.retry;
			return {
				retryable: retry._tag === "Retryable",
				retryAfterMs: retry._tag === "Retryable" ? (retry.retryAfterMs ?? null) : null,
			};
		}
		case "StreamProviderError": {
			const f = failure as unknown as {
				providerError: { message: string; type: string | null; code: string | null; param: string | null };
				response: { status: number };
			};
			return { retryable: providerErrorRetryable(f.providerError, f.response.status), retryAfterMs: null };
		}
		case "StreamStartProviderCorrectnessViolation":
		case "StreamStartClientCorrectnessViolation":
		case "StreamProviderCorrectnessViolation":
		case "StreamClientCorrectnessViolation":
			return { retryable: false, retryAfterMs: null };
		default:
			return { retryable: false, retryAfterMs: null };
	}
}

export function snapshotModelAttemptFailure(failure: { _tag: string; [key: string]: unknown }) {
	const retry = retryHintForSnapshot(failure);
	return {
		phase: failure._tag.startsWith("StreamStart") ? "stream_start" : ("stream" as "stream_start" | "stream"),
		tag: failure._tag,
		detailTag: detailTag(failure),
		message: formatModelAttemptFailureMessage(failure),
		call: (failure as unknown as { call: { method: string; url: string; provider: string; model: string } }).call,
		responseStatus:
			"response" in failure && (failure as unknown as { response: unknown }).response !== null
				? (failure as unknown as { response: { status: number } }).response.status
				: null,
		trace: traceRef(failure),
		progress:
			"progress" in failure
				? ((failure as unknown as { progress: unknown }).progress as {
						dataPayloadsDecoded: number;
						modelEventsEmitted: number;
					} | null)
				: null,
		retryable: retry.retryable,
		retryAfterMs: retry.retryAfterMs,
	};
}

export const CONTEXT_LIMIT_PATTERNS = [
	"prompt is too long",
	"token count exceeds the maximum",
	"maximum context length",
	"context_length_exceeded",
	"exceeded model token limit",
];

export const TRANSIENT_PROVIDER_PATTERNS = [
	"timeout",
	"timed_out",
	"temporarily_unavailable",
	"unavailable",
	"overloaded",
	"rate_limit",
	"server_error",
	"internal_error",
	"upstream_unavailable",
	"stream_interrupted",
];
