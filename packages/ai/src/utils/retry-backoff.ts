/**
 * Pure retry-backoff delay helper.
 * packages/agent/src/util/retry-backoff.ts (artifact line 71036).
 *
 * Framework-agnostic: no @effect/* import.
 *
 * NOTE on pi's existing retryDelayMs in packages/ai/src/api/commandcode.ts:100:
 * commandcode.retryDelayMs uses 20% jitter + treats Retry-After as a hard cap
 * (returns -1 when Retry-After exceeds maxDelayMs). This module uses NO jitter
 * and treats server hints as a FLOOR (Math.max(hint, computed)). The two
 * variants coexist — the jittered one stays for API-page retry in commandcode;
 * this pure variant is for future connection-level retry loops.
 */

export const MAX_RETRIES = 5;
export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 30_000;

export const TERMINAL_RETRY_EXHAUSTED_MESSAGE =
	"Lost connection to the model provider. Check your network and try again.";

/**
 * Compute the delay (ms) before the next retry.
 * - No hint: exponential `BASE_DELAY_MS * 2^attempt`, capped at MAX_DELAY_MS.
 * - Hint present: max(hint, computed) so the server hint is a floor, not a ceiling.
 */
export function computeDelayMs(attempt: number, hintMs?: number): number {
	const computed = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
	return hintMs !== undefined ? Math.max(hintMs, computed) : computed;
}

/**
 * Extract a server-supplied retry hint (ms) from a retryable outcome.
 * Returns undefined when the outcome is not a connection failure or when
 * the failure carries no `retryAfterMs`.
 */
export interface RetryAfterOutcome {
	readonly _tag: string;
	readonly detail?: { readonly failure?: { readonly retryAfterMs?: number } };
}

export function getRetryAfterHint(outcome: RetryAfterOutcome): number | undefined {
	if (outcome._tag !== "ConnectionFailure") return undefined;
	return outcome.detail?.failure?.retryAfterMs ?? undefined;
}

/** Adapter for fetch retry loops which parse Retry-After headers. */
export function getRetryAfterHintFromHeader(
	retryAfterHeader: string | null,
	now: number = Date.now(),
): number | undefined {
	if (!retryAfterHeader) return undefined;
	const trimmed = retryAfterHeader.trim();
	// Retry-After as seconds (HTTP spec: non-negative integer).
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	// Reject any other pure-numeric form (signed/decimal/whitespace-number) — never a date.
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
	const date = Date.parse(trimmed);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** True when attempt index >= MAX_RETRIES, used to terminate retry loops. */
export function isRetryExhausted(attempt: number): boolean {
	return attempt >= MAX_RETRIES;
}

/**
 * Optional Effect Schedule bridge — lives in packages/agent if/when adopted.
 *
 * import { Schedule } from "@effect/schedule";
 * export const connectionRetrySchedule = Schedule.intersect(
 * Schedule.recurs(MAX_RETRIES - 1),
 * Schedule.exponential(`${BASE_DELAY_MS} millis`, 2),
 *);
 */
