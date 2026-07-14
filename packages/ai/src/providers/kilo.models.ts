// Static catalog for the Kilo provider (OpenRouter-compatible gateway).
// Kilo exposes 300+ models via a single gateway; this file pins the free-tier
// models so the provider is usable without a network fetch or API key.
// See https://github.com/apmantza/pi-free for the dynamic model list.

import type { Model } from "../types.ts";

export const KILO_BASE_URL = "https://api.kilo.ai/api/gateway";

export const KILO_MODELS = {
	"tencent/hy3:free": {
		id: "tencent/hy3:free",
		name: "Tencent: Hunyuan 3 (free)",
		api: "openai-completions",
		provider: "kilo",
		baseUrl: KILO_BASE_URL,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: false,
			thinkingFormat: "openrouter",
			maxTokensField: "max_tokens",
		},
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128000,
		maxTokens: 8192,
	} satisfies Model<"openai-completions">,
} satisfies Record<string, Model<"openai-completions">>;

export type KiloModelId = keyof typeof KILO_MODELS;
