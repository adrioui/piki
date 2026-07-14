import { failureOption, isCause, pretty } from "effect/Cause";

export interface UnknownErrorDetail {
	_tag: "Unknown";
	message: string;
}

export interface UnexpectedError {
	_tag: "UnexpectedError";
	detail: UnknownErrorDetail;
	requestId: string | null;
}

function describeThrown(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) {
		const name = value.name || "Error";
		return value.message ? `${name}: ${value.message}` : name;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function stackTraceLines(value: unknown): string[] {
	if (!(value instanceof Error) || !value.stack) return [];
	const frames = value.stack
		.split("\n")
		.slice(1)
		.map((line) => line.trim())
		.filter(Boolean);
	return frames.length > 0 ? ["stack:", ...frames] : [];
}

function unknownErrorDetail(err: unknown): UnknownErrorDetail {
	if (isCause(err)) {
		const failure = failureOption(err);
		if (failure._tag === "Some") return unknownErrorDetail(failure.value);
		return {
			_tag: "Unknown",
			message: ["Unexpected runtime error", "cause:", pretty(err)].join("\n"),
		};
	}
	return {
		_tag: "Unknown",
		message: ["Unexpected runtime error", `error: ${describeThrown(err)}`, ...stackTraceLines(err)].join("\n"),
	};
}

export function classifyUnknownError(err: unknown): UnexpectedError {
	return {
		_tag: "UnexpectedError",
		detail: unknownErrorDetail(err),
		requestId: null,
	};
}
