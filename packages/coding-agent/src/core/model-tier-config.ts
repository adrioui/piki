/**
 * Model tier configuration — moved out of agent-model-resolver.ts for maintainability.
 * Model IDs break when versions change; config makes them maintainable.
 * Users can override via .piki/settings.local.json.
 */

import type { ModelTier } from "@piki/event-core";

const DEFAULT_TIER_MODEL_IDS: Record<ModelTier, string[]> = {
	fast: ["commandcode/xiaomi/mimo-v2.5-pro"],
	smart: ["commandcode/deepseek/deepseek-v4-pro"],
	"smart+thinking": ["commandcode/deepseek/deepseek-v4-pro"],
	"smart+high-temp+thinking": ["commandcode/deepseek/deepseek-v4-pro"],
};

/**
 * Get model IDs for a tier, with optional user overrides.
 */
export function getTierModelIds(tier: ModelTier, overrides?: Partial<Record<ModelTier, string[]>>): string[] {
	return overrides?.[tier] ?? DEFAULT_TIER_MODEL_IDS[tier] ?? [];
}

export { DEFAULT_TIER_MODEL_IDS };
