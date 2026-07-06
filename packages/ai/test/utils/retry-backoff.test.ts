import { describe, expect, it } from "vitest";
import {
	computeDelayMs,
	getRetryAfterHint,
	getRetryAfterHintFromHeader,
	isRetryExhausted,
	MAX_DELAY_MS,
	MAX_RETRIES,
} from "../../src/utils/retry-backoff.ts";

describe("computeDelayMs", () => {
	it("no hint → exponential capped at MAX_DELAY_MS", () => {
		expect(computeDelayMs(0)).toBe(500);
		expect(computeDelayMs(1)).toBe(1000);
		expect(computeDelayMs(5)).toBe(16000);
		expect(computeDelayMs(7)).toBe(MAX_DELAY_MS); // 64000 capped → 30000
		expect(computeDelayMs(99)).toBe(MAX_DELAY_MS);
	});

	it("hint > computed → hint wins (hint is a floor)", () => {
		expect(computeDelayMs(0, 5000)).toBe(5000);
		expect(computeDelayMs(3, 4500)).toBe(4500); // computed 4000 < 4500
	});

	it("hint < computed → computed wins", () => {
		expect(computeDelayMs(5, 100)).toBe(16000); // computed 16000 > 100
	});

	it("attempt overflow caps at MAX_DELAY_MS regardless of hint below cap", () => {
		expect(computeDelayMs(100, 1000)).toBe(MAX_DELAY_MS); // hint(1000) < cap(30000) → cap
	});
});

describe("getRetryAfterHint", () => {
	it("returns undefined for non-connection failures", () => {
		expect(getRetryAfterHint({ _tag: "Other" })).toBeUndefined();
	});

	it("returns retryAfterMs when present (ConnectionFailure)", () => {
		expect(
			getRetryAfterHint({
				_tag: "ConnectionFailure",
				detail: { failure: { retryAfterMs: 2500 } },
			}),
		).toBe(2500);
	});

	it("returns undefined when retryAfterMs is absent", () => {
		expect(getRetryAfterHint({ _tag: "ConnectionFailure", detail: { failure: {} } })).toBeUndefined();
		expect(getRetryAfterHint({ _tag: "ConnectionFailure" })).toBeUndefined();
	});
});

describe("getRetryAfterHintFromHeader", () => {
	it("parses seconds form", () => {
		expect(getRetryAfterHintFromHeader("30")).toBe(30_000);
	});

	it("parses HTTP-date form against a fixed now", () => {
		const now = Date.parse("2026-07-05T00:00:00Z");
		const future = new Date(now + 12_000).toUTCString();
		expect(getRetryAfterHintFromHeader(future, now)).toBe(12_000);
	});

	it("returns undefined for null/garbage/NaN", () => {
		expect(getRetryAfterHintFromHeader(null)).toBeUndefined();
		expect(getRetryAfterHintFromHeader("nope")).toBeUndefined();
		expect(getRetryAfterHintFromHeader("-5")).toBeUndefined();
	});
});

describe("isRetryExhausted", () => {
	it("true at and above MAX_RETRIES", () => {
		expect(isRetryExhausted(MAX_RETRIES)).toBe(true);
		expect(isRetryExhausted(MAX_RETRIES + 1)).toBe(true);
		expect(isRetryExhausted(MAX_RETRIES - 1)).toBe(false);
	});
});
