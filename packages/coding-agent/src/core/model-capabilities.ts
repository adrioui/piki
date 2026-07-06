import type { Api, Model } from "@piki/ai";

export interface ModelCapabilities {
	vision: boolean;
	longContext: boolean;
	reasoning: boolean;
	cacheControl: boolean;
	longCacheRetention: boolean;
	toolCacheControl: boolean;
	strictTools: boolean;
	parallelToolCalls: boolean;
	grammar: boolean;
}

const LONG_CONTEXT_THRESHOLD = 200_000;

/**
 * Derive coding-agent capability flags from existing model metadata.
 * This is intentionally a pure helper: it does not introduce new model schema.
 */
export function deriveModelCapabilities(model: Model<Api>): ModelCapabilities {
	const compat = model.compat;
	const supportsLongCacheRetention =
		compat && "supportsLongCacheRetention" in compat ? compat.supportsLongCacheRetention !== false : false;
	const cacheControl =
		model.api === "anthropic-messages" ||
		Boolean(compat && "cacheControlFormat" in compat && compat.cacheControlFormat === "anthropic");
	const toolCacheControl =
		compat && "supportsCacheControlOnTools" in compat ? compat.supportsCacheControlOnTools !== false : cacheControl;
	const strictTools = compat && "supportsStrictMode" in compat ? compat.supportsStrictMode !== false : true;

	return {
		vision: model.input.includes("image"),
		longContext: model.contextWindow >= LONG_CONTEXT_THRESHOLD,
		reasoning: model.reasoning,
		cacheControl,
		longCacheRetention: supportsLongCacheRetention,
		toolCacheControl,
		strictTools,
		parallelToolCalls: true,
		grammar: model.grammar === true,
	};
}
