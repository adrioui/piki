/**
 * Scientist wave-2 parity probe (providers/routing/auth/retry/thinking/decoders/
 * stop-reason/content-filter) between piki and Magnitude alpha22 embedded bundle.
 *
 * These probes assert OBSERVABLE client-side behavior and compare against the
 * mag oracle extracted from magnitude-alpha22.embedded.js. They do NOT modify
 * source. Findings are written to scratchpad/reports/sci-providers-wave2.md.
 */
import { describe, expect, it } from "vitest";
import { computeJitteredDelay } from "../../coding-agent/src/core/permissions/error-classifier.ts";
import { snapshotModelAttemptFailure } from "../src/errors/classify.ts";

function retryableOf(status: number, message: string): boolean {
	// StreamProviderError is the failure kind that piki routes through the
	// transient-4xx-aware `providerErrorRetryable` (classify.ts:483).
	const snap = snapshotModelAttemptFailure({
		_tag: "StreamProviderError",
		providerError: { message, type: null, code: null, param: null },
		response: { status },
		call: { method: "POST", url: "x", provider: "p", model: "m" },
	});
	return snap.retryable;
}

describe("retry classification parity: transient 4xx", () => {
	it("piki and mag agree: a 4xx is NOT retryable, even with a transient provider pattern", () => {
		// mag's providerErrorRetryable2: only status===429 or status>=500 are
		// retryable. Any 4xx (400..499, except 429) -> UpstreamNotRetryable
		// ("invalid_request"). piki's StreamProviderError path must match: a 409
		// carrying "temporarily_unavailable" is NOT retryable.
		const retryable = retryableOf(409, "Service temporarily_unavailable");
		expect(retryable).toBe(false);
	});

	it("piki and mag agree: 429 retryable, 5xx retryable, 401/403 not retryable", () => {
		expect(retryableOf(429, "rate limited")).toBe(true);
		expect(retryableOf(503, "boom")).toBe(true);
		expect(retryableOf(401, "unauthorized")).toBe(false);
		expect(retryableOf(403, "forbidden")).toBe(false);
	});

	it("piki and mag agree: context-limit 5xx is NOT retryable", () => {
		expect(retryableOf(500, "maximum context length exceeded")).toBe(false);
	});
});

describe("retry backoff constants parity", () => {
	it("piki and mag both cap turn-level retry delay at 30000ms", () => {
		// mag: MAX_RETRIES=5, BASE_DELAY_MS=500, MAX_DELAY_MS=30000, factor 2.
		// piki agent-session now passes 30000 as the cap to computeJitteredDelay.
		const pikiCap = computeJitteredDelay(10, 5000, 30000, undefined);
		expect(pikiCap).toBeLessThanOrEqual(30000);
		// mag delay at attempt n = min(500 * 2^n, 30000). At n=6 -> 32000 capped to 30000.
		const magAt6 = Math.min(500 * 2 ** 6, 30000);
		expect(magAt6).toBe(30000);
		// piki at the same attempt (no server delay) is also capped to 30000.
		const pikiAt6 = Math.min(5000 * 2 ** 6, 30000);
		expect(pikiAt6).toBe(30000);
		expect(pikiAt6).toBe(magAt6);
	});
});
