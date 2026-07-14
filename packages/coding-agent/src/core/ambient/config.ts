import { calculateContextCaps, ROLE_DEFINITIONS } from "@piki/event-core";
import { Effect } from "effect";
import { ambientDefine } from "../projection/projection.ts";

/**
 * A resolved model profile for a given role. Matches the `toModelProfile`
 * shape (packages/agent/src/ambient/config-ambient.ts).
 */
export interface ModelProfile {
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly capabilities: {
		readonly vision: boolean;
		readonly grammar: boolean;
		readonly reasoning: { readonly type: string };
	};
}

/**
 * Per-role resolved config (alpha: `state.byRole[roleId]`).
 */
export interface RoleConfig {
	readonly modelId: string;
	readonly profile: ModelProfile;
	readonly hardCap: number;
	readonly softCap: number;
}

export interface ConfigState {
	contextWindow: number;
	maxOutputTokens: number;
	capabilities: { vision: boolean; grammar: boolean; reasoning: { type: string } };
	/** Role-indexed resolved configs (piki-shaped). */
	readonly byRole: Record<string, RoleConfig>;
	/** Whether a model catalog has been loaded to refine per-role profiles. */
	readonly catalogLoaded: boolean;
	[key: string]: unknown;
}

/**
 * Conservative fallback profile used when no model catalog entry matches a role.
 * Copied verbatim from alpha22 (packages/agent/src/ambient/config-ambient.ts).
 */
export const FALLBACK_PROFILE: ModelProfile = {
	contextWindow: 200000,
	maxOutputTokens: 16384,
	capabilities: { vision: true, grammar: false, reasoning: { type: "none" } },
};

/**
 * Build the initial {@link ConfigState}, resolving a {@link RoleConfig} per role.
 *
 * Faithful to alpha22 `buildConfigState` (capture 82286–82295): iterate every
 * role id, derive `hardCap` from the fallback context window minus the output
 * reserve, and compute `softCap` via {@link calculateContextCaps} (which applies
 * `DEFAULT_CONTEXT_LIMIT_POLICY`: `softCapRatio = 0.9`, capped at `200000`).
 * When a model catalog is available the per-role profile can be refined later
 * (piki-extensible — `byRole` is the single extension surface).
 */
export function buildConfigState(): ConfigState {
	const byRole: Record<string, RoleConfig> = {};
	for (const roleId of Object.keys(ROLE_DEFINITIONS)) {
		const modelId = `role/${roleId}`;
		const profile = FALLBACK_PROFILE;
		// `calculateContextCaps` subtracts OUTPUT_TOKEN_RESERVE from the profile's
		// context window to derive `hardCap`, then applies the soft-cap policy —
		// mirroring alpha's `hardCap = profile.contextWindow - OUTPUT_TOKEN_RESERVE`
		// followed by `computeContextLimits(hardCap, policy)`.
		const { hardCap, softCap } = calculateContextCaps(profile.contextWindow);
		byRole[roleId] = { modelId, profile, hardCap, softCap };
	}
	return {
		contextWindow: FALLBACK_PROFILE.contextWindow,
		maxOutputTokens: FALLBACK_PROFILE.maxOutputTokens,
		capabilities: FALLBACK_PROFILE.capabilities,
		byRole,
		catalogLoaded: false,
	};
}

/**
 * Resolve the per-role config for `roleId` from a {@link ConfigState}.
 *
 * Resolved model-profile shape (packages/agent/src/ambient/config-ambient.ts).
 * Returns `undefined` when the role is unknown so callers can guard
 * (alpha callers assume presence; piki guards to stay `no-undefined` safe).
 */
export function getRoleConfig(state: ConfigState, roleId: string): RoleConfig | undefined {
	return state.byRole[roleId];
}

export const ConfigAmbient = ambientDefine<ConfigState>({
	name: "Config",
	initial: Effect.succeed(buildConfigState()),
});
