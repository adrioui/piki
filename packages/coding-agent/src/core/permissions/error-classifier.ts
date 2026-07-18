/**
 * Amp-style HTTP error and retry classifier.
 *
 * Categorizes errors into retryable/non-retryable with clear user-facing
 * messages, respecting server timing headers for jittered backoff.
 */

/** Categories for error classification. */
export type ErrorCategory =
	| "timeout"
	| "network"
	| "rate_limited"
	| "auth"
	| "quota"
	| "context_length"
	| "permission_denied"
	| "server_error"
	| "conflict"
	| "client_error"
	| "unknown";

export interface ErrorClassification {
	category: ErrorCategory;
	retryable: boolean;
	/** User-facing message explaining the error and what to do. */
	message: string;
	/** Retry delay in milliseconds (from server header or computed jitter). */
	retryDelayMs?: number;
}

/** Result from parsing retry headers. */
export interface RetryHeaders {
	/** Millisecond delay from `retry-after-ms` header. */
	delayMs?: number;
	/** Seconds delay from `Retry-After` header (HTTP-date or seconds). */
	retryAfterSeconds?: number;
	/** Whether `x-should-retry` header is true. */
	shouldRetry?: boolean;
}

/**
 * Parse retry-related headers from a server response.
 */
export function parseRetryHeaders(headers: Record<string, string>): RetryHeaders {
	const result: RetryHeaders = {};

	// x-should-retry: boolean
	const shouldRetry = headers["x-should-retry"] ?? headers["X-Should-Retry"] ?? "";
	if (shouldRetry.toLowerCase() === "true") {
		result.shouldRetry = true;
	}

	// retry-after-ms: integer milliseconds
	const retryAfterMs = headers["retry-after-ms"] ?? headers["x-retry-after-ms"] ?? "";
	if (retryAfterMs) {
		const parsed = parseInt(retryAfterMs, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			result.delayMs = parsed;
		}
	}

	// Retry-After: HTTP-date or seconds
	const retryAfter = headers["retry-after"] ?? headers["Retry-After"] ?? "";
	if (retryAfter) {
		const seconds = parseInt(retryAfter, 10);
		if (!Number.isNaN(seconds) && seconds > 0) {
			result.retryAfterSeconds = seconds;
		} else {
			// Try parsing as HTTP-date
			const date = new Date(retryAfter);
			if (!Number.isNaN(date.getTime())) {
				const now = Date.now();
				if (date.getTime() > now) {
					result.retryAfterSeconds = Math.ceil((date.getTime() - now) / 1000);
				}
			}
		}
	}

	return result;
}

/**
 * Compute a jittered retry delay.
 *
 * Base delay uses the server-provided delay when available, otherwise falls
 * back to exponential backoff. Jitter adds +/- 25% randomness.
 */
export function computeJitteredDelay(
	attempt: number,
	baseDelayMs: number = 1000,
	maxDelayMs: number = 60000,
	serverDelayMs?: number,
): number {
	const base = serverDelayMs ?? Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
	// +/- 25% jitter
	const jitter = base * 0.25;
	const delay = base - jitter + Math.random() * jitter * 2;
	return Math.min(Math.round(delay), maxDelayMs);
}

/**
 * Classify an error by HTTP status code.
 */
export function classifyByStatus(status: number | undefined, headers?: Record<string, string>): ErrorClassification {
	switch (status) {
		case 401:
		case 403:
			return {
				category: "auth",
				retryable: false,
				message:
					status === 401
						? "Authentication failed. Check your API key or login credentials."
						: "Access denied. You do not have permission to use this resource.",
			};
		case 408:
			return {
				category: "timeout",
				retryable: false,
				message: "Request timed out. The server took too long to respond.",
			};
		case 409:
			return {
				category: "conflict",
				retryable: false,
				message: "Request conflict. The operation could not be completed due to a conflicting state.",
			};
		case 429: {
			const retryHeaders = headers ? parseRetryHeaders(headers) : {};
			const delayMs = retryHeaders.delayMs ?? (retryHeaders.retryAfterSeconds ?? 5) * 1000;
			return {
				category: "rate_limited",
				retryable: true,
				message: "Rate limited. Too many requests. Waiting before retrying.",
				retryDelayMs: delayMs,
			};
		}
		case 413:
			return {
				category: "context_length",
				retryable: false,
				message:
					"Request too large. The context is too long for the model. Consider compacting the conversation or starting a new thread.",
			};
		default:
			if (status && status >= 500 && status < 600) {
				const retryHeaders = headers ? parseRetryHeaders(headers) : {};
				const delayMs = retryHeaders.delayMs;
				return {
					category: "server_error",
					retryable: true,
					message: `Server error (HTTP ${status}). The provider is experiencing issues.`,
					retryDelayMs: delayMs ?? computeJitteredDelay(0, 5000, 30000),
				};
			}
			if (status && status >= 400 && status < 500) {
				return {
					category: "client_error",
					retryable: false,
					message: `Client error (HTTP ${status}). Check your request parameters.`,
				};
			}
			return {
				category: "unknown",
				retryable: false,
				message: `Unexpected error (HTTP ${status ?? "unknown"}).`,
			};
	}
}

/**
 * Classify an error from an Error object or error message string.
 */
export function classifyError(error: unknown, headers?: Record<string, string>): ErrorClassification {
	if (!error) {
		return { category: "unknown", retryable: false, message: "Unknown error" };
	}

	const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();

	// Check semantic patterns FIRST before extracting status codes
	// (to avoid matching port numbers like 443 as HTTP status)

	// Timeout
	if (
		lower.includes("timeout") ||
		lower.includes("timed out") ||
		lower.includes("etimedout") ||
		lower.includes("econnreset") ||
		lower.includes("socket hang up")
	) {
		return {
			category: "timeout",
			retryable: true,
			message: "Request timed out or connection was lost. Retrying with backoff.",
		};
	}

	// Network errors
	if (
		lower.includes("network") ||
		lower.includes("econnrefused") ||
		lower.includes("connection refused") ||
		lower.includes("connection lost") ||
		lower.includes("connection error") ||
		lower.includes("enotfound") ||
		lower.includes("getaddrinfo") ||
		lower.includes("fetch failed") ||
		lower.includes("unreachable") ||
		lower.includes("websocket") ||
		lower.includes("other side closed") ||
		lower.includes("upstream connect") ||
		lower.includes("reset before headers") ||
		lower.includes("stream ended before") ||
		lower.includes("ended without") ||
		lower.includes("http2") ||
		lower.includes("terminated") ||
		lower.includes("retry delay") ||
		lower.includes("server_error") ||
		lower.includes("internal_error")
	) {
		return {
			category: "network",
			retryable: true,
			message: "Network error. The provider could not be reached.",
		};
	}

	// Quota or account usage limits. Check before HTTP status so a provider
	// body like "429 Daily token quota reached" is not treated as transient.
	if (
		lower.includes("quota") ||
		lower.includes("credit") ||
		lower.includes("insufficient") ||
		lower.includes("billing") ||
		lower.includes("payment") ||
		lower.includes("usage limit") ||
		lower.includes("limit_reached") ||
		lower.includes("resource_exhausted")
	) {
		return {
			category: "quota",
			retryable: false,
			message: "Quota exceeded or insufficient credits. Check your billing plan or wait for quota reset.",
		};
	}

	// Check for known HTTP status patterns
	const KNOWN_STATUSES = [401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504];
	const statusMatch = message.match(/\b(\d{3})\b/);
	if (statusMatch) {
		const status = parseInt(statusMatch[1]!, 10);
		if (KNOWN_STATUSES.includes(status)) {
			return classifyByStatus(status, headers);
		}
	}

	// Rate limiting (from message text)
	if (lower.includes("too many requests") || lower.includes("rate limit") || lower.includes("throttl")) {
		return {
			category: "rate_limited",
			retryable: true,
			message: "Rate limited. Too many requests. Waiting before retrying.",
		};
	}

	// Auth
	// Word-boundary "auth" excludes false positives: "author", "reauthorize",
	// "authoritative", "authorization". Real auth failures say "authenticat*",
	// "credentials", or the standalone token "auth".
	if (
		lower.includes("unauthorized") ||
		lower.includes("unauthenticated") ||
		lower.includes("api key") ||
		lower.includes("api_key") ||
		lower.includes("invalid key") ||
		lower.includes("invalid authentication") ||
		/\bauthenticat(e|ed|ion|ing)\b/.test(lower) ||
		/\bcredentials?\b/.test(lower) ||
		/\bauth\b/.test(lower) ||
		/\b401\b/.test(lower) ||
		/\b403\b/.test(lower)
	) {
		return {
			category: "auth",
			retryable: false,
			message: "Authentication failed. Check your API key or login credentials.",
		};
	}

	// Context length
	if (
		lower.includes("context length") ||
		lower.includes("context window") ||
		lower.includes("maximum context") ||
		lower.includes("prompt is too long") ||
		lower.includes("string too long") ||
		lower.includes("token limit")
	) {
		return {
			category: "context_length",
			retryable: false,
			message: "Context too long. Consider compacting the conversation or starting a new thread.",
		};
	}

	// Permission denied
	if (
		lower.includes("permission denied") ||
		lower.includes("permission_denied") ||
		lower.includes("forbidden") ||
		lower.includes("access denied")
	) {
		return {
			category: "permission_denied",
			retryable: false,
			message: "Permission denied. You do not have the required access for this operation.",
		};
	}

	// Server errors — match status codes on word boundaries to avoid
	// false-positives on numbers like "5000", "15023", etc.
	if (
		/\b500\b/.test(lower) ||
		/\b502\b/.test(lower) ||
		/\b503\b/.test(lower) ||
		/\b504\b/.test(lower) ||
		lower.includes("internal server error") ||
		lower.includes("service unavailable") ||
		lower.includes("bad gateway") ||
		lower.includes("overloaded") ||
		lower.includes("provider returned error")
	) {
		return classifyByStatus(503, headers);
	}

	// Explicit provider retry guidance: OpenAI Responses and Bedrock stream
	// exceptions that explicitly tell the caller to retry the request (#6019).
	// These are transient upstream failures, not quota/auth/client errors.
	if (
		lower.includes("you can retry your request") ||
		lower.includes("try your request again") ||
		lower.includes("please retry your request")
	) {
		return {
			category: "server_error",
			retryable: true,
			message: "Provider requested a retry. Retrying automatically.",
			retryDelayMs: computeJitteredDelay(0, 5000, 30000),
		};
	}

	// Default: unknown, non-retryable
	return {
		category: "unknown",
		retryable: false,
		message: `Unexpected error: ${message.length > 200 ? `${message.slice(0, 200)}...` : message}`,
	};
}

/**
 * Build a user-friendly error string from an ErrorClassification.
 */
export function formatErrorClassification(classification: ErrorClassification): string {
	const action = classification.retryable ? "Will retry automatically." : "Cannot retry automatically.";
	return `[${classification.category}] ${classification.message} ${action}`;
}
