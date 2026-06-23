/**
 * Model lineage classification and prompt-profile routing.
 *
 * Architecture note: this module deliberately separates three concerns that
 * the first iteration conflated:
 *
 * - ModelLineage: the model's open-source/closed-weight lineage, e.g. glm,
 *   qwen, llama. This is a property of the *model*, discovered primarily from
 *   its id/name fragments (e.g. "deepseek", "meta.llama*"), not of the
 *   provider. A provider like amazon-bedrock or openrouter hosts many
 *   lineages, so provider alone is not a reliable signal.
 * - PromptProfile: which system-prompt style to use. Today only two styles
 *   exist: "default" and "open-source-explicit". The explicit style is reserved
 *   for open-source/open-weight lineages that empirically benefit from layered,
 *   explicit instructions.
 * - Provider: used only as a fallback when a dedicated single-lineage provider
 *   is involved and the model id does not itself identify an open-source
 *   lineage (e.g. anthropic -> claude, zai -> glm).
 *
 * "open-source" here means a public/open-weight model lineage, not a generic
 * provider behavior bucket.
 */

/** Recognized model lineages. */
export type ModelLineage =
	| "claude"
	| "openai"
	| "gemini"
	| "glm"
	| "kimi"
	| "qwen"
	| "llama"
	| "mistral"
	| "deepseek"
	| "gemma"
	| "gpt-oss"
	| "grok"
	| "mimo"
	| "unknown";

/** Which system-prompt style to render. */
export type PromptProfile = "default" | "open-source-explicit";

/**
 * Open-source/open-weight lineages that get the explicit prompt style.
 *
 * Kimi is included: Moonshot positions Kimi K2.x as open-weight / open-source
 * (GitHub: MoonshotAI/Kimi-K2, Hugging Face: moonshotai/Kimi-K2.6,
 * moonshotai/Kimi-K2.7-Code) and as an agentic, coding-focused model. Routing
 * Kimi to the explicit profile means using pi's reliability-oriented prompt,
 * NOT Amp's Kimi speed/rush prompt.
 */
const OPEN_SOURCE_EXPLICIT_LINEAGES: ReadonlySet<ModelLineage> = new Set<ModelLineage>([
	"glm",
	"qwen",
	"llama",
	"mistral",
	"deepseek",
	"gemma",
	"gpt-oss",
	"kimi",
	"mimo",
]);

/**
 * Lowercased fragments that identify a lineage from the model id/name.
 * Checked in declaration order; first match wins. Bedrock model ids use a
 * "vendor." prefix (e.g. "meta.llama3", "deepseek.r1", "openai.gpt-oss-*"),
 * which these fragments also match.
 *
 * IMPORTANT: these fragments are matched against modelId + modelName ONLY, never
 * the provider string. This keeps multi-lineage providers (amazon-bedrock,
 * openrouter, together) from being misclassified by their provider name.
 */
const LINEAGE_FRAGMENTS: ReadonlyArray<{ fragment: string; lineage: ModelLineage }> = [
	{ fragment: "glm-", lineage: "glm" },
	{ fragment: "glm/", lineage: "glm" },
	{ fragment: "gpt-oss", lineage: "gpt-oss" },
	{ fragment: "claude", lineage: "claude" },
	{ fragment: "gemini", lineage: "gemini" },
	{ fragment: "qwen", lineage: "qwen" },
	{ fragment: "llama", lineage: "llama" },
	{ fragment: "mistral", lineage: "mistral" },
	{ fragment: "mixtral", lineage: "mistral" },
	{ fragment: "codestral", lineage: "mistral" },
	{ fragment: "devstral", lineage: "mistral" },
	{ fragment: "deepseek", lineage: "deepseek" },
	{ fragment: "gemma", lineage: "gemma" },
	{ fragment: "kimi", lineage: "kimi" },
	{ fragment: "grok", lineage: "grok" },
	{ fragment: "mimo", lineage: "mimo" },
];

/**
 * Providers that serve a single lineage, used as a fallback ONLY after model
 * id/name fragment matching fails. This handles opaque model ids on dedicated
 * providers (e.g. zai with an opaque id but a GLM name is caught by the name;
 * this fallback covers the case where neither id nor name carry a fragment).
 */
const PROVIDER_LINEAGE_FALLBACK: ReadonlyMap<string, ModelLineage> = new Map<string, ModelLineage>([
	["anthropic", "claude"],
	["openai", "openai"],
	["openai-codex", "openai"],
	["azure-openai-responses", "openai"],
	["google", "gemini"],
	["google-vertex", "gemini"],
	["zai", "glm"],
	["zai-coding-cn", "glm"],
	["moonshotai", "kimi"],
	["moonshotai-cn", "kimi"],
	["kimi-coding", "kimi"],
	["xai", "grok"],
]);

/**
 * Model-aware prompt variant. Inspired by Amp's cj5() → pj5() → *K4() routing.
 *
 * Unlike PromptProfile (which is a binary open-source vs default split),
 * PromptVariant provides fine-grained per-model-family prompt instructions
 * that address each model's specific strengths and weaknesses.
 *
 * - default: Claude-family — assume strong instruction following
 * - open-source-explicit: open-weight models that need structured instructions
 * - kimi-explicit: Kimi K2.x — speed/efficiency oriented, strong parallelization
 * - grok-explicit: xAI/Grok — allows special agent persona
 * - openai-explicit: GPT-family — imperative guardrails, verification gates
 * - gemini-explicit: Gemini — benefits from few-shot examples
 */
export type PromptVariant =
	| "default"
	| "open-source-explicit"
	| "kimi-explicit"
	| "grok-explicit"
	| "openai-explicit"
	| "gemini-explicit";

/**
 * Resolve the prompt variant for a lineage. Maps each lineage to its optimal
 * prompt variant, combining both the open-source explicit concern and the
 * model-family-specific concern.
 */
export function resolvePromptVariant(lineage: ModelLineage | undefined): PromptVariant {
	switch (lineage) {
		case "kimi":
			return "kimi-explicit";
		case "grok":
			return "grok-explicit";
		case "openai":
			return "openai-explicit";
		case "gemini":
			return "gemini-explicit";
		default:
			// Open-source lineages get the explicit prompt
			if (lineage && OPEN_SOURCE_EXPLICIT_LINEAGES.has(lineage)) {
				return "open-source-explicit";
			}
			return "default";
	}
}

/** Convenience: classify lineage then resolve its prompt variant. */
export function classifyPromptVariant(
	provider: string | undefined,
	modelId: string | undefined,
	modelName: string | undefined,
): PromptVariant {
	return resolvePromptVariant(classifyModelLineage(provider, modelId, modelName));
}

/** Whether the variant is an open-source explicit style. */
export function isOpenSourceExplicitVariant(variant: PromptVariant | undefined): boolean {
	return variant === "open-source-explicit";
}

/**
 * Classify a model's lineage. Classification is structural (provider id +
 * model id + model display name) so it can be unit-tested without depending on
 * the Model type from @earendil-works/pi-ai.
 *
 * Order of precedence:
 * 1. Model id/name fragments (strong signal of the actual lineage; works for
 *    multi-lineage providers like amazon-bedrock, openrouter, together). The
 *    provider string is deliberately NOT part of the fragment haystack.
 * 2. Provider fallback (only for dedicated single-lineage providers).
 *
 * Returns "unknown" when nothing matches, which keeps the default prompt.
 */
export function classifyModelLineage(
	provider: string | undefined,
	modelId: string | undefined,
	modelName: string | undefined,
): ModelLineage {
	// Fragment matching inspects ONLY modelId + modelName, never the provider.
	// The display name often carries the lineage for opaque ids (e.g. zai with
	// id "chat" but name "GLM-5.2").
	const haystack = `${modelId ?? ""} ${modelName ?? ""}`.toLowerCase();

	for (const { fragment, lineage } of LINEAGE_FRAGMENTS) {
		if (haystack.includes(fragment)) {
			return lineage;
		}
	}

	const providerLineage = PROVIDER_LINEAGE_FALLBACK.get((provider ?? "").toLowerCase());
	if (providerLineage) {
		return providerLineage;
	}

	return "unknown";
}

/**
 * Resolve the prompt profile for a lineage. Open-source/open-weight lineages
 * use the explicit prompt style; everything else uses the default.
 */
export function resolvePromptProfile(lineage: ModelLineage | undefined): PromptProfile {
	if (lineage && OPEN_SOURCE_EXPLICIT_LINEAGES.has(lineage)) {
		return "open-source-explicit";
	}
	return "default";
}

/** Convenience: classify lineage then resolve its prompt profile. */
export function classifyPromptProfile(
	provider: string | undefined,
	modelId: string | undefined,
	modelName: string | undefined,
): PromptProfile {
	return resolvePromptProfile(classifyModelLineage(provider, modelId, modelName));
}

/** Whether the profile renders the explicit open-source prompt style. */
export function isOpenSourceExplicitProfile(profile: PromptProfile | undefined): boolean {
	return profile === "open-source-explicit";
}
