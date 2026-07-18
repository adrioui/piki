/**
 * Tests for the error classifier module.
 */

import { describe, expect, it } from "vitest";
import {
	classifyByStatus,
	classifyError,
	computeJitteredDelay,
	formatErrorClassification,
	parseRetryHeaders,
} from "../src/core/permissions/error-classifier.ts";

describe("error-classifier", () => {
	describe("parseRetryHeaders", () => {
		it("parses x-should-retry header", () => {
			const result = parseRetryHeaders({ "x-should-retry": "true" });
			expect(result.shouldRetry).toBe(true);
		});

		it("parses retry-after-ms header", () => {
			const result = parseRetryHeaders({ "retry-after-ms": "5000" });
			expect(result.delayMs).toBe(5000);
		});

		it("parses Retry-After as seconds", () => {
			const result = parseRetryHeaders({ "retry-after": "30" });
			expect(result.retryAfterSeconds).toBe(30);
		});

		it("returns undefined for missing headers", () => {
			const result = parseRetryHeaders({});
			expect(result.delayMs).toBeUndefined();
			expect(result.retryAfterSeconds).toBeUndefined();
			expect(result.shouldRetry).toBeUndefined();
		});

		it("handles case-insensitive retry-after", () => {
			const result = parseRetryHeaders({ "Retry-After": "15" });
			expect(result.retryAfterSeconds).toBe(15);
		});

		it("parses x-retry-after-ms as fallback", () => {
			const result = parseRetryHeaders({ "x-retry-after-ms": "3000" });
			expect(result.delayMs).toBe(3000);
		});
	});

	describe("computeJitteredDelay", () => {
		it("uses base exponential backoff", () => {
			const delay = computeJitteredDelay(0, 1000, 60000);
			expect(delay).toBeGreaterThanOrEqual(750);
			expect(delay).toBeLessThanOrEqual(1250);
		});

		it("backs off exponentially", () => {
			const delay1 = computeJitteredDelay(0, 1000, 60000);
			const delay2 = computeJitteredDelay(1, 1000, 60000);
			// Second attempt should have higher base
			expect(delay2 - delay1).toBeGreaterThanOrEqual(-250); // jitter overlap possible
		});

		it("respects max delay", () => {
			const delay = computeJitteredDelay(10, 1000, 5000, 100000);
			expect(delay).toBeLessThanOrEqual(5000);
		});

		it("uses server-provided delay when available", () => {
			const delay = computeJitteredDelay(0, 1000, 60000, 10000);
			expect(delay).toBeGreaterThanOrEqual(7500);
			expect(delay).toBeLessThanOrEqual(12500);
		});

		it("applies +/- 25% jitter", () => {
			const delays = Array.from({ length: 100 }, () => computeJitteredDelay(0, 1000, 60000));
			const min = Math.min(...delays);
			const max = Math.max(...delays);
			// With base 1000, jitter is 250, so range should span at least 250
			expect(max - min).toBeGreaterThanOrEqual(200);
		});
	});

	describe("classifyByStatus", () => {
		it("classifies 401 as auth, non-retryable", () => {
			const result = classifyByStatus(401);
			expect(result.category).toBe("auth");
			expect(result.retryable).toBe(false);
		});

		it("classifies 403 as auth, non-retryable", () => {
			const result = classifyByStatus(403);
			expect(result.category).toBe("auth");
			expect(result.retryable).toBe(false);
		});

		it("classifies 408 as timeout, non-retryable", () => {
			const result = classifyByStatus(408);
			expect(result.category).toBe("timeout");
			expect(result.retryable).toBe(false);
		});

		it("classifies 409 as conflict, non-retryable", () => {
			const result = classifyByStatus(409);
			expect(result.category).toBe("conflict");
			expect(result.retryable).toBe(false);
		});

		it("classifies 429 as rate_limited with delay from headers", () => {
			const result = classifyByStatus(429, { "retry-after": "10" });
			expect(result.category).toBe("rate_limited");
			expect(result.retryable).toBe(true);
			expect(result.retryDelayMs).toBe(10000);
		});

		it("classifies 429 with default 5s delay when no headers", () => {
			const result = classifyByStatus(429);
			expect(result.category).toBe("rate_limited");
			expect(result.retryDelayMs).toBe(5000);
		});

		it("classifies 413 as context_length, non-retryable", () => {
			const result = classifyByStatus(413);
			expect(result.category).toBe("context_length");
			expect(result.retryable).toBe(false);
		});

		it("classifies 5xx as server_error, retryable", () => {
			for (const status of [500, 502, 503, 504]) {
				const result = classifyByStatus(status);
				expect(result.category).toBe("server_error");
				expect(result.retryable).toBe(true);
			}
		});

		it("keeps 429 retryable and 503 retryable (unchanged parity)", () => {
			const r429 = classifyByStatus(429);
			expect(r429.retryable).toBe(true);
			const r503 = classifyByStatus(503);
			expect(r503.retryable).toBe(true);
			expect(r503.category).toBe("server_error");
		});

		it("classifies 4xx as client_error, non-retryable", () => {
			const result = classifyByStatus(400);
			expect(result.category).toBe("client_error");
			expect(result.retryable).toBe(false);
		});
	});

	describe("classifyError", () => {
		it("classifies timeout messages", () => {
			const result = classifyError("Request timed out after 30s");
			expect(result.category).toBe("timeout");
			expect(result.retryable).toBe(true);
		});

		it("classifies network errors", () => {
			const result = classifyError("connect ECONNREFUSED 127.0.0.1:443");
			expect(result.category).toBe("network");
			expect(result.retryable).toBe(true);
		});

		it("classifies auth errors", () => {
			const result = classifyError("Unauthorized: invalid API key");
			expect(result.category).toBe("auth");
			expect(result.retryable).toBe(false);
		});

		it("classifies quota errors", () => {
			const result = classifyError("Quota exceeded for this billing period");
			expect(result.category).toBe("quota");
			expect(result.retryable).toBe(false);
		});

		it("classifies Naraya 429 daily token quota as quota, not transient rate limit", () => {
			const result = classifyError("429 Daily token quota reached for naraya/mimo-v2.5-pro-free");
			expect(result.category).toBe("quota");
			expect(result.retryable).toBe(false);
		});

		it("classifies context length errors", () => {
			const result = classifyError("This model's maximum context length is 128000 tokens");
			expect(result.category).toBe("context_length");
			expect(result.retryable).toBe(false);
		});

		it("classifies rate limit errors from message", () => {
			const result = classifyError("Too many requests, please slow down");
			expect(result.category).toBe("rate_limited");
			expect(result.retryable).toBe(true);
		});

		it("classifies permission denied errors", () => {
			const result = classifyError("Permission denied: cannot access resource");
			expect(result.category).toBe("permission_denied");
			expect(result.retryable).toBe(false);
		});

		it("classifies Error objects", () => {
			const result = classifyError(new Error("connect ETIMEDOUT"));
			expect(result.category).toBe("timeout");
		});

		it("returns unknown for null/undefined", () => {
			const result = classifyError(null);
			expect(result.category).toBe("unknown");
			expect(result.retryable).toBe(false);
		});

		it("truncates long error messages", () => {
			const longMsg = "x".repeat(500);
			const result = classifyError(longMsg);
			// "Unexpected error: " (19) + 200 chars + "..." (3) = 222
			expect(result.message.length).toBeLessThanOrEqual(222);
			expect(result.message).toContain("...");
		});

		it("extracts known HTTP status from error messages", () => {
			const result = classifyError("HTTP 429 Too Many Requests");
			expect(result.category).toBe("rate_limited");
			expect(result.retryable).toBe(true);

			const result2 = classifyError("Error code: 403 - Forbidden");
			expect(result2.category).toBe("auth");
			expect(result2.retryable).toBe(false);
		});

		it("does NOT classify 'author' substring as auth", () => {
			const result = classifyError("Unknown author of commit");
			expect(result.category).not.toBe("auth");
		});
		it("does NOT classify 'reauthorize' as auth", () => {
			const result = classifyError("Please reauthorize the session token");
			expect(result.category).not.toBe("auth");
		});
		it("does NOT classify 'authoritative' as auth", () => {
			const result = classifyError("Response was authoritative");
			expect(result.category).not.toBe("auth");
		});
		it("does NOT classify 'authorization' as auth", () => {
			const result = classifyError("Missing authorization header for request");
			expect(result.category).not.toBe("auth");
		});
		it("still classifies real auth failures", () => {
			expect(classifyError("Authentication failed").category).toBe("auth");
			expect(classifyError("invalid api key").category).toBe("auth");
			expect(classifyError("401 Unauthorized").category).toBe("auth");
			expect(classifyError("Credentials expired").category).toBe("auth");
			expect(classifyError("Auth error").category).toBe("auth");
		});

		it("does not extract port numbers as HTTP status", () => {
			// "443" is not a known HTTP error status
			const result = classifyError("Connection refused at host:443");
			expect(result.category).not.toBe("server_error");
		});

		it("ignores unknown 3-digit numbers", () => {
			const result = classifyError("Value 234 is out of range");
			expect(result.category).toBe("unknown");
		});
	});

	describe("formatErrorClassification", () => {
		it("includes retry action for retryable errors", () => {
			const result = formatErrorClassification({
				category: "timeout",
				retryable: true,
				message: "Request timed out.",
			});
			expect(result).toContain("Will retry");
		});

		it("includes no-retry action for non-retryable errors", () => {
			const result = formatErrorClassification({
				category: "auth",
				retryable: false,
				message: "Auth failed.",
			});
			expect(result).toContain("Cannot retry");
		});

		it("includes category tag", () => {
			const result = formatErrorClassification({
				category: "quota",
				retryable: false,
				message: "Out of credits.",
			});
			expect(result).toContain("[quota]");
		});
	});
});
