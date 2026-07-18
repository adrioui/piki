/**
 * Model tier configuration — moved out of agent-model-resolver.ts for maintainability.
 * Model IDs break when versions change; config makes them maintainable.
 * Users can override per-role model selection via `roleModels` in .piki/settings.json
 * (see SettingsManager.getRoleModels()).
 */

import type { ThinkingLevel } from "@piki/agent-core";
import type { ModelTier } from "@piki/event-core";

/**
 * Default model IDs per role, matching Magnitude alpha22's proxy config map.
 * These take precedence over the tier fallbacks below because alpha22's map is
 * per-role, not purely per-tier (e.g. artisan is `smart` tier but uses
 * `deepseek-v4-flash`; engineer is `fast` tier but uses `hy3:free`).
 *
 * To preserve alpha22's Fast-vs-Smart+thinking split, the per-role ids are
 * tier-faithful: the `smart+thinking` roles (critic/architect/scientist) use a
 * thinking-capable model, while the `fast` roles (engineer) use a fast model.
 * User `roleModels` overrides (via settings) still win in AgentModelResolver.
 */
export const DEFAULT_ROLE_MODEL_IDS: Record<string, string> = {
	leader: "clinepass/cline-pass/mimo-v2.5-pro",
	critic: "commandcode/deepseek/deepseek-v4-pro",
	architect: "commandcode/deepseek/deepseek-v4-pro",
	scientist: "commandcode/deepseek/deepseek-v4-pro",
	advisor: "openai/gpt-5.6-sol",
	engineer: "xiaomi/mimo-v2.5-pro",
	scout: "clinepass/cline-pass/deepseek-v4-flash",
	artisan: "clinepass/cline-pass/deepseek-v4-flash",
	observer: "clinepass/cline-pass/deepseek-v4-flash",
};

const DEFAULT_TIER_MODEL_IDS: Record<ModelTier, string[]> = {
	fast: ["xiaomi/mimo-v2.5-pro"],
	smart: ["commandcode/deepseek/deepseek-v4-pro"],
	"smart+thinking": ["commandcode/deepseek/deepseek-v4-pro"],
	"smart+high-temp+thinking": ["commandcode/deepseek/deepseek-v4-pro"],
};

/**
 * Resolve the configured model id for a role, honoring runtime overrides
 * (from settings) over the built-in per-role defaults.
 */
export function resolveRoleModelId(role: string, overrides?: Record<string, string>): string | undefined {
	return overrides?.[role] ?? DEFAULT_ROLE_MODEL_IDS[role];
}

/**
 * Get model IDs for a tier, with optional user overrides.
 */
export function getTierModelIds(tier: ModelTier, overrides?: Partial<Record<ModelTier, string[]>>): string[] {
	return overrides?.[tier] ?? DEFAULT_TIER_MODEL_IDS[tier] ?? [];
}

/**
 * Map a model tier to a default thinking level, mirroring Magnitude alpha22's
 * per-role thinking behavior. The `smart+thinking` tiers enable reasoning;
 * the `fast` tier disables it; `smart` falls back to the caller's default.
 *
 * @param tier the role model tier
 * @param fallback the thinking level to use for non-thinking tiers (defaults to "off")
 */
export function getThinkingLevelForTier(tier: ModelTier | undefined, fallback: ThinkingLevel = "off"): ThinkingLevel {
	switch (tier) {
		case "smart+thinking":
		case "smart+high-temp+thinking":
			return "medium";
		case "fast":
			return "off";
		default:
			return fallback;
	}
}

export { DEFAULT_TIER_MODEL_IDS };
