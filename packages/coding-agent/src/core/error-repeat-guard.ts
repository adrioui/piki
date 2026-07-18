export interface ErrorRepeatGuardResult {
	repeatCount: number;
	threshold: number;
	shouldStop: boolean;
	fingerprint: string;
}

export interface ErrorRepeatGuardOptions {
	threshold?: number;
}

const DEFAULT_ERROR_REPEAT_THRESHOLD = 3;

export class ErrorRepeatGuard {
	private readonly threshold: number;
	private readonly counts = new Map<string, number>();

	constructor(options: ErrorRepeatGuardOptions = {}) {
		this.threshold = options.threshold ?? DEFAULT_ERROR_REPEAT_THRESHOLD;
	}

	recordError(toolName: string, args: unknown, errorText: string, category?: string): ErrorRepeatGuardResult {
		const fingerprint = `${toolName}:${fingerprintArgs(args)}:${normalizeError(errorText)}:${category ?? ""}`;
		const repeatCount = (this.counts.get(fingerprint) ?? 0) + 1;
		this.counts.set(fingerprint, repeatCount);
		return {
			repeatCount,
			threshold: this.threshold,
			shouldStop: repeatCount >= this.threshold,
			fingerprint,
		};
	}

	recordSuccess(toolName: string, args: unknown): void {
		const fingerprint = `${toolName}:${fingerprintArgs(args)}`;
		// Clear all error variants for this tool+args fingerprint
		for (const key of this.counts.keys()) {
			if (key.startsWith(`${fingerprint}:`)) {
				this.counts.delete(key);
			}
		}
	}
}

function fingerprintArgs(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJson);
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([key]) => !isVolatileKey(key))
		.sort(([left], [right]) => left.localeCompare(right));
	const sorted: Record<string, unknown> = {};
	for (const [key, entryValue] of entries) {
		sorted[key] = sortJson(entryValue);
	}
	return sorted;
}

function isVolatileKey(key: string): boolean {
	const normalized = key.toLowerCase();
	return normalized === "timestamp" || normalized === "time" || normalized === "startedat" || normalized === "endedat";
}

function normalizeError(errorText: string): string {
	const firstLine = errorText.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
	return firstLine
		.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
		.replace(/\/(?:[^/\s]+\/)+[^/\s]+/g, "<path>")
		.trim()
		.toLowerCase();
}
