/**
 * Context-limit policy — resolves model context-window caps by reusing
 * event-core's calculateContextCaps (hard-cap/soft-cap math) and extending
 * it with maxOutputTokens + reserveInputTokens fields.
 *
 * G19: provides computeContextLimits for ConfigStorage.
 */

import { calculateContextCaps, OUTPUT_TOKEN_RESERVE } from "@piki/event-core";
import type { ResolvedModelConfig } from "./config-storage.ts";

/** Conservative default when a model's max-output-tokens is unspecified. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Compute resolved limits for a model config.
 *
 * DELTA-extends calculateContextCaps (event-core/constants.ts:17):
 * preserves {hardCap, softCap} and ADDS {maxOutputTokens, reserveInputTokens}.
 * Does NOT re-implement cap math — delegates to event-core.
 */
export function computeContextLimits(mc: {
	modelId: string;
	contextWindow: number;
	maxOutputTokens: number;
}): ResolvedModelConfig {
	const { hardCap, softCap } = calculateContextCaps(mc.contextWindow);
	return {
		modelId: mc.modelId,
		contextWindow: mc.contextWindow,
		maxOutputTokens: mc.maxOutputTokens,
		reserveInputTokens: OUTPUT_TOKEN_RESERVE,
		hardCap,
		softCap,
	};
}

/**
 * Convenience: the recommended compaction-trigger threshold for a resolved config.
 * Surfaces the policy-derived softCap (DEFAULT_CONTEXT_LIMIT_POLICY.softCapRatio=0.9,
 * capped at 200 000) rather than the legacy `contextLimit * 0.8`.
 */
export function compactionTriggerThreshold(rc: ResolvedModelConfig): number {
	return rc.softCap;
}
