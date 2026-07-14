/**
 * Tagged error classes and helpers for model stream failures.
 */

import { Cause, Data } from "effect";

const TRACE_HEADER = "x-piki-trace-id";
const REQUEST_ID_HEADER = "x-request-id";
const textEncoder = new TextEncoder();

type ModelStreamTerminalValue =
	| {
			_tag: "StreamCompleted";
			call: { provider: string; model: string; method: string; url: string };
			response: {
				status: number;
				headers: Array<[string, string]>;
				requestId: string | null;
				traceId: string | null;
			};
			finishReason: string;
			progress: { dataPayloadsDecoded: number; modelEventsEmitted: number };
			usage: { _tag: "UsageReported"; usage: unknown } | { _tag: "UsageNotReported"; reason: string };
	  }
	| {
			_tag: "StreamFailed";
			cause:
				| StreamStartOperationalFailure
				| StreamStartProviderRejection
				| StreamStartProviderCorrectnessViolation
				| StreamStartClientCorrectnessViolation
				| StreamOperationalFailure
				| StreamProviderError
				| StreamProviderCorrectnessViolation
				| StreamClientCorrectnessViolation;
			usage: { _tag: "UsageReported"; usage: unknown } | { _tag: "UsageNotReported"; reason: string };
	  };

export function headerListFromHeaders(headers: Headers | Record<string, string>): Array<[string, string]> {
	const result: Array<[string, string]> = [];
	if (headers instanceof Headers) {
		headers.forEach((value, name) => {
			result.push([name.toLowerCase(), value]);
		});
	} else {
		for (const [name, value] of Object.entries(headers)) {
			if (value !== undefined) result.push([name.toLowerCase(), value]);
		}
	}
	return result;
}

export function headersFromHeaderList(headers: Array<[string, string]>): Headers {
	const result = new Headers();
	for (const [name, value] of headers) {
		result.set(name, value);
	}
	return result;
}

export function getHeader(headers: Array<[string, string]>, name: string): string | null {
	const lower = name.toLowerCase();
	for (const [headerName, value] of headers) {
		if (headerName.toLowerCase() === lower) return value;
	}
	return null;
}

export function retryAfterMsFromHeaders(headers: Array<[string, string]>): number | null {
	const value = getHeader(headers, "retry-after");
	if (value === null) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return seconds * 1000;
	const date = Date.parse(value);
	if (Number.isFinite(date)) return Math.max(0, date - Date.now());
	return null;
}

export function acceptedHttpResponse(status: number, headers: Headers | Record<string, string>) {
	const headerList = headerListFromHeaders(headers);
	return {
		status,
		headers: headerList,
		requestId: getHeader(headerList, REQUEST_ID_HEADER),
		traceId: getHeader(headerList, TRACE_HEADER),
	};
}

export function rejectedHttpResponse(status: number, headers: Headers | Record<string, string>, body: string) {
	const headerList = headerListFromHeaders(headers);
	return {
		status,
		headers: headerList,
		body,
		requestId: getHeader(headerList, REQUEST_ID_HEADER),
		traceId: getHeader(headerList, TRACE_HEADER),
		retryAfterMs: retryAfterMsFromHeaders(headerList),
	};
}

export function toCauseInfo(cause: unknown) {
	if (Cause.isCause(cause)) {
		return { _tag: "Cause" as const, pretty: Cause.pretty(cause) };
	}
	if (cause instanceof Error) {
		return {
			_tag: "ErrorCause" as const,
			name: cause.name || "Error",
			message: cause.message || cause.name || "Error",
		};
	}
	if (typeof cause === "string") {
		return { _tag: "StringCause" as const, message: cause };
	}
	return { _tag: "UnknownCause" as const, description: describeUnknown(cause) };
}

export function payloadSample(text: string, maxBytes = 4096) {
	const bytes = textEncoder.encode(text);
	if (bytes.byteLength <= maxBytes) {
		return { text, encodedBytes: bytes.byteLength, truncated: false };
	}
	const slice = bytes.slice(0, maxBytes);
	return {
		text: new TextDecoder().decode(slice),
		encodedBytes: bytes.byteLength,
		truncated: true,
	};
}

export function causeInfoText(cause: ReturnType<typeof toCauseInfo>): string {
	switch (cause._tag) {
		case "ErrorCause":
			return `${cause.name}: ${cause.message}`;
		case "StringCause":
			return cause.message;
		case "Cause":
			return cause.pretty;
		case "UnknownCause":
			return cause.description;
	}
}

export function describeUnknown(value: unknown): string {
	if (value == null) return "unavailable";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

type StreamFailureFields = Readonly<Record<string, unknown>>;

export class StreamStartOperationalFailure extends Data.TaggedError(
	"StreamStartOperationalFailure",
)<StreamFailureFields> {}
export class StreamStartProviderRejection extends Data.TaggedError(
	"StreamStartProviderRejection",
)<StreamFailureFields> {}
export class StreamStartProviderCorrectnessViolation extends Data.TaggedError(
	"StreamStartProviderCorrectnessViolation",
)<StreamFailureFields> {}
export class StreamStartClientCorrectnessViolation extends Data.TaggedError(
	"StreamStartClientCorrectnessViolation",
)<StreamFailureFields> {}
export class StreamOperationalFailure extends Data.TaggedError("StreamOperationalFailure")<StreamFailureFields> {}
export class StreamProviderError extends Data.TaggedError("StreamProviderError")<StreamFailureFields> {}
export class StreamProviderCorrectnessViolation extends Data.TaggedError(
	"StreamProviderCorrectnessViolation",
)<StreamFailureFields> {}
export class StreamClientCorrectnessViolation extends Data.TaggedError(
	"StreamClientCorrectnessViolation",
)<StreamFailureFields> {}

export const makeModelStreamTerminal = {
	StreamCompleted: (args: Omit<Extract<ModelStreamTerminalValue, { _tag: "StreamCompleted" }>, "_tag">) =>
		({ _tag: "StreamCompleted", ...args }) as const,
	StreamFailed: (args: Omit<Extract<ModelStreamTerminalValue, { _tag: "StreamFailed" }>, "_tag">) =>
		({ _tag: "StreamFailed", ...args }) as const,
	$is:
		(tag: ModelStreamTerminalValue["_tag"]) =>
		(value: unknown): value is ModelStreamTerminalValue =>
			typeof value === "object" && value !== null && "_tag" in value && value._tag === tag,
	$match:
		<R>(cases: {
			StreamCompleted: (value: Extract<ModelStreamTerminalValue, { _tag: "StreamCompleted" }>) => R;
			StreamFailed: (value: Extract<ModelStreamTerminalValue, { _tag: "StreamFailed" }>) => R;
		}) =>
		(value: ModelStreamTerminalValue): R =>
			value._tag === "StreamCompleted" ? cases.StreamCompleted(value) : cases.StreamFailed(value),
};

export const ModelStreamTerminal = {
	StreamCompleted: (args: Omit<Extract<ModelStreamTerminalValue, { _tag: "StreamCompleted" }>, "_tag">) =>
		({ _tag: "StreamCompleted", ...args }) as const,
	StreamFailed: (args: Omit<Extract<ModelStreamTerminalValue, { _tag: "StreamFailed" }>, "_tag">) =>
		({ _tag: "StreamFailed", ...args }) as const,
	hadPartialOutput: (terminal: ModelStreamTerminalValue) => {
		const progress = terminal._tag === "StreamCompleted" ? terminal.progress : terminal.cause.progress;
		return typeof progress === "object" && progress !== null && "modelEventsEmitted" in progress
			? Number(progress.modelEventsEmitted) > 0
			: false;
	},
	$is: makeModelStreamTerminal.$is,
	$match: makeModelStreamTerminal.$match,
};

export { TRACE_HEADER, REQUEST_ID_HEADER };
