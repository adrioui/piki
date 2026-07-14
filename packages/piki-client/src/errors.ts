import {
	getHeader,
	payloadSample,
	StreamStartProviderCorrectnessViolation,
	StreamStartProviderRejection,
} from "@piki/ai";

/**
 * Error envelope parsing + classification for the piki API.
 */

function notRetryable(reason: string) {
	return { _tag: "NotRetryable" as const, reason };
}

function retryable(retryAfterMs: number | null) {
	return { _tag: "Retryable" as const, retryAfterMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorType(value: unknown): value is string {
	return typeof value === "string" && ERROR_TYPES.includes(value);
}

function isErrorCode(value: unknown): value is string {
	return typeof value === "string" && ERROR_CODES.includes(value);
}

function isInsufficientCreditsDetails(value: unknown): value is {
	category: "insufficient_credits";
	balanceCents: number;
} {
	return isRecord(value) && value.category === "insufficient_credits" && typeof value.balanceCents === "number";
}

function tryParseErrorBody(body: string): {
	error: {
		message: string;
		type: string;
		param: string | null;
		code: string;
		details?: { category: "insufficient_credits"; balanceCents: number };
	};
} | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const error = parsed.error;
	if (!isRecord(error)) return null;
	if (typeof error.message !== "string" || error.message.trim().length === 0) return null;
	if (!isErrorType(error.type)) return null;
	if (!isErrorCode(error.code)) return null;
	if (error.param !== null && typeof error.param !== "string") return null;
	const base = {
		message: error.message,
		type: error.type,
		param: error.param as string | null,
	};
	if (error.code === "insufficient_credits") {
		if (!isInsufficientCreditsDetails(error.details)) return null;
		return {
			error: {
				...base,
				code: error.code,
				details: error.details,
			},
		};
	}
	return {
		error: {
			...base,
			code: error.code as string,
		},
	};
}

function isContextLimit(message: string): boolean {
	const text = message.toLowerCase();
	return [
		"prompt is too long",
		"token count exceeds the maximum",
		"maximum context length",
		"context_length_exceeded",
		"exceeded model token limit",
	].some((pattern) => text.includes(pattern));
}

type RetryPolicy = { _tag: "NotRetryable"; reason: string } | { _tag: "Retryable"; retryAfterMs: number | null };

type ClassifiedError =
	| {
			_tag: "InsufficientCredits";
			status: number;
			message: string;
			traceId: string | null;
			balanceCents: number;
			retry: RetryPolicy;
	  }
	| { _tag: "AuthRejected"; status: number; message: string; traceId: string | null; retry: RetryPolicy }
	| { _tag: "ModelNotFound"; status: number; message: string; traceId: string | null; retry: RetryPolicy }
	| { _tag: "ModelNotMultimodal"; status: number; message: string; traceId: string | null; retry: RetryPolicy }
	| { _tag: "ModelNotGrammarCompatible"; status: number; message: string; traceId: string | null; retry: RetryPolicy }
	| {
			_tag: "RateLimited";
			status: number;
			message: string;
			traceId: string | null;
			retryAfterMs: unknown;
			retry: RetryPolicy;
	  }
	| { _tag: "GatewayFailure"; status: number; message: string; traceId: string | null; retry: RetryPolicy }
	| { _tag: "ContextLimitExceeded"; status: number; message: string; traceId: string | null; retry: RetryPolicy }
	| { _tag: "InvalidRequest"; status: number; message: string; traceId: string | null; retry: RetryPolicy };

function classifyPikiError(
	response: { status: number; retryAfterMs: unknown },
	parsed: NonNullable<ReturnType<typeof tryParseErrorBody>>,
	traceId: string | null,
): ClassifiedError {
	const { error } = parsed;
	const base = {
		status: response.status,
		message: error.message,
		traceId,
	};
	if (error.code === "insufficient_credits" && error.details) {
		return {
			_tag: "InsufficientCredits",
			...base,
			balanceCents: error.details.balanceCents,
			retry: notRetryable("billing"),
		};
	}
	switch (error.code) {
		case "invalid_api_key":
			return { _tag: "AuthRejected", ...base, retry: notRetryable("auth") };
		case "model_not_found":
			return { _tag: "ModelNotFound", ...base, retry: notRetryable("model_unavailable") };
		case "model_not_multimodal":
			return { _tag: "ModelNotMultimodal", ...base, retry: notRetryable("model_unavailable") };
		case "model_not_grammar_compatible":
			return { _tag: "ModelNotGrammarCompatible", ...base, retry: notRetryable("model_unavailable") };
		case "provider_rate_limited":
			return {
				_tag: "RateLimited",
				...base,
				retryAfterMs: response.retryAfterMs,
				retry: retryable(response.retryAfterMs as number | null),
			};
		case "internal_server_error":
		case "provider_error":
		case "upstream_unavailable":
		case "stream_interrupted":
			return { _tag: "GatewayFailure", ...base, retry: retryable(null) };
		default:
			if (error.type === "authentication_error" || response.status === 401 || response.status === 403) {
				return { _tag: "AuthRejected", ...base, retry: notRetryable("auth") };
			}
			if (error.type === "rate_limit_error" || response.status === 429) {
				return {
					_tag: "RateLimited",
					...base,
					retryAfterMs: response.retryAfterMs,
					retry: retryable(response.retryAfterMs as number | null),
				};
			}
			if (isContextLimit(error.message)) {
				return { _tag: "ContextLimitExceeded", ...base, retry: notRetryable("context_limit") };
			}
			return { _tag: "InvalidRequest", ...base, retry: notRetryable("invalid_request") };
	}
}

function classifyPikiRejectedResponse(
	call: unknown,
	response: { status: number; headers: Array<[string, string]>; body: string; retryAfterMs: unknown },
): StreamStartProviderCorrectnessViolation | StreamStartProviderRejection {
	const traceId = getHeader(response.headers, TRACE_HEADER2)?.trim() ?? null;
	if (traceId === null) {
		return new StreamStartProviderCorrectnessViolation({
			call,
			response,
			violation: {
				_tag: "MissingRequiredResponseMetadata",
				field: "traceId",
				status: response.status,
				body: payloadSample(response.body),
			},
		});
	}
	const parsed = tryParseErrorBody(response.body);
	if (parsed === null) {
		return new StreamStartProviderCorrectnessViolation({
			call,
			response,
			violation: {
				_tag: "InvalidErrorEnvelope",
				status: response.status,
				body: payloadSample(response.body),
				issue: { message: "piki error response did not match the expected envelope shape" },
			},
		});
	}
	return new StreamStartProviderRejection({
		call,
		response,
		rejection: classifyPikiError(response, parsed, traceId),
	});
}

const TRACE_HEADER2 = "x-piki-trace-id";
const ERROR_TYPES = [
	"invalid_request_error",
	"authentication_error",
	"insufficient_quota",
	"rate_limit_error",
	"server_error",
	"service_unavailable",
];
const ERROR_CODES = [
	"invalid_api_key",
	"invalid_body",
	"unsupported_field",
	"unsupported_n",
	"invalid_image_url",
	"invalid_multimodal_role",
	"model_not_found",
	"model_not_multimodal",
	"model_not_grammar_compatible",
	"insufficient_credits",
	"provider_rate_limited",
	"internal_server_error",
	"provider_error",
	"upstream_unavailable",
	"stream_interrupted",
];

export { classifyPikiError, classifyPikiRejectedResponse, TRACE_HEADER2, ERROR_TYPES, ERROR_CODES };
