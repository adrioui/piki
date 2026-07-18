/**
 * O3 — Settings defaults parity (harness-only, no source change).
 *
 * mag resolves an explicit default model/thinking level from config; piki does
 * the same via SettingsManager. This fixture asserts the resolution path
 * surfaces the configured defaults (and the documented fallback keep-ratio for
 * compaction) deterministically, using an in-memory SettingsManager so no
 * external config or provider is touched. There is no fixed mag model target to
 * compare against (model selection is config-driven), so we assert
 * non-emptiness / correctness of the resolved values rather than a hard-coded
 * mag string.
 */

import { KEEP_MESSAGE_RATIO } from "@piki/event-core";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("O3 — settings defaults resolution parity", () => {
	it("resolves an explicitly configured default model and thinking level", () => {
		const sm = SettingsManager.inMemory({
			defaultModel: "openai/gpt-5",
			defaultThinkingLevel: "medium" as never,
		});
		expect(sm.getDefaultModel()).toBe("openai/gpt-5");
		expect(sm.getDefaultThinkingLevel()).toBe("medium");
	});

	it("falls back to the documented compaction keep-ratio constant when unset", () => {
		const sm = SettingsManager.inMemory({});
		// 0.1 default (event-core KEEP_MESSAGE_RATIO) — matches mag's
		// keepRatio-driven recent-context retention.
		expect(sm.getCompactionKeepRatio()).toBe(KEEP_MESSAGE_RATIO);
		expect(sm.getCompactionKeepRatio()).toBeGreaterThan(0);
	});
});
