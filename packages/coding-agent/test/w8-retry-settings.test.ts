import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

// W8 re-litigation of provider retry layering parity (re-litigate P4 / sci-s7-providers G1/G2).
// The mag oracle (magnitude-alpha22.embedded.js) retries at the TURN/connection level via
// `Effect.retry({ schedule: connectionRetrySchedule, while: UpstreamRetryable })` on
// `harness.runTurn(...)`, with MAX_RETRIES=5. There is NO request-level SDK maxRetries anywhere
// in mag's model-streaming HTTP path. piki mirrors this with a turn-level retry whose default
// maxRetries is 5. This probe asserts that piki's turn-level retry defaults match mag's count.

function freshManager(): SettingsManager {
	return SettingsManager.fromStorage(new InMemorySettingsStorage());
}

describe("w8 retry layering: turn-level defaults vs mag", () => {
	it("turn-level retry defaults to maxRetries=5 (matches mag MAX_RETRIES=5)", () => {
		const settings = freshManager().getRetrySettings();
		expect(settings.enabled).toBe(true);
		expect(settings.maxRetries).toBe(5);
		// baseDelayMs is a piki-product choice; mag uses 500ms base, piki 5000ms.
		// Documented as intentional divergence, not a mag-blocking gap.
		expect(settings.baseDelayMs).toBeGreaterThan(0);
	});

	it("provider request-level maxRetries is undefined by default (mag has no request-level retry)", () => {
		const provider = freshManager().getProviderRetrySettings();
		// piki's adapters fall through `options?.maxRetries ?? provider.maxRetries ?? 0`,
		// so a default of undefined here means the adapter passes maxRetries: 0 to the SDK,
		// which matches mag (no request-level retry layer at all).
		expect(provider.maxRetries).toBeUndefined();
		expect(provider.maxRetryDelayMs).toBe(60000);
	});
});
