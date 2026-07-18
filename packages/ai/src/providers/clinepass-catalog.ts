import type { Model } from "../types.ts";

export const CLINEPASS_BASE_URL = "https://api.cline.bot";
export const CLINEPASS_MODELS_URL = "https://api.cline.bot/api/v1/models";
export const CLINEPASS_API_BASE_ENV = "CLINE_API_BASE";
export const CLINEPASS_API_KEY_ENV = "CLINE_API_KEY";

const DEFAULT_THINKING_LEVEL_MAP = {
	off: "off",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

const NO_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function toMillionTokenPrice(value: unknown, fallback: number): number {
	const parsed = numberValue(value);
	return parsed === undefined ? fallback : parsed * 1_000_000;
}

function normalizeApiBase(value: string | undefined): string {
	const trimmed = value?.trim();
	return trimmed ? trimmed.replace(/\/+$/, "") : CLINEPASS_BASE_URL;
}

export function clinePassApiBase(env: Record<string, string | undefined> = process.env): string {
	return normalizeApiBase(env[CLINEPASS_API_BASE_ENV]);
}

export interface ClinePassRemoteModelsOptions {
	apiBase?: string;
	apiKey?: string;
	fetchImpl?: typeof fetch;
}

export const CLINEPASS_STATIC_MODELS = [
	{
		id: "cline-pass/glm-5.2",
		name: "GLM-5.2 (ClinePass)",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 131_072,
		thinkingLevelMap: {
			off: "off",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "cline-pass/kimi-k2.7-code",
		name: "Kimi K2.7 Code (ClinePass)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 131_072,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "cline-pass/kimi-k2.6",
		name: "Kimi K2.6 (ClinePass)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 131_072,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "cline-pass/deepseek-v4-pro",
		name: "DeepSeek V4 Pro (ClinePass)",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		thinkingLevelMap: { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: "high" },
	},
	{
		id: "cline-pass/deepseek-v4-flash",
		name: "DeepSeek V4 Flash (ClinePass)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		thinkingLevelMap: { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: "high" },
	},
	{
		id: "cline-pass/mimo-v2.5",
		name: "MiMo-V2.5 (ClinePass)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 131_072,
		thinkingLevelMap: {
			off: "off",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "cline-pass/mimo-v2.5-pro",
		name: "MiMo-V2.5-Pro (ClinePass)",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 131_072,
		thinkingLevelMap: {
			off: "off",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "cline-pass/minimax-m3",
		name: "MiniMax M3 (ClinePass)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinkingLevelMap: {
			off: "off",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "cline-pass/qwen3.7-max",
		name: "Qwen3.7 Max (ClinePass)",
		reasoning: true,
		input: ["text"],
		cost: { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 },
		contextWindow: 262_144,
		maxTokens: 131_072,
		thinkingLevelMap: {
			off: "off",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "cline-pass/qwen3.7-plus",
		name: "Qwen3.7 Plus (ClinePass)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinkingLevelMap: {
			off: "off",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
].map((model) => ({
	...model,
	input: model.input as Model<"openai-completions">["input"],
	api: "openai-completions",
	provider: "clinepass",
	baseUrl: `${CLINEPASS_BASE_URL}/api/v1`,
})) satisfies readonly Model<"openai-completions">[];

function parseRemoteModel(
	raw: Record<string, unknown>,
	fallback?: Model<"openai-completions">,
): Model<"openai-completions"> | undefined {
	const id = stringValue(raw.id);
	if (!id?.startsWith("cline-pass/")) return undefined;

	const pricing = isRecord(raw.pricing) ? raw.pricing : undefined;
	const reasoning = booleanValue(raw.reasoning) ?? fallback?.reasoning ?? true;
	return {
		id,
		name: stringValue(raw.name) ?? fallback?.name ?? `${id} (ClinePass)`,
		api: "openai-completions",
		provider: "clinepass",
		baseUrl: `${CLINEPASS_BASE_URL}/api/v1`,
		reasoning,
		input: ["text"],
		cost: {
			input: toMillionTokenPrice(pricing?.prompt, fallback?.cost.input ?? 0),
			output: toMillionTokenPrice(pricing?.completion, fallback?.cost.output ?? 0),
			cacheRead: toMillionTokenPrice(pricing?.cached_input, fallback?.cost.cacheRead ?? 0),
			cacheWrite: fallback?.cost.cacheWrite ?? 0,
		},
		contextWindow: numberValue(raw.context_length) ?? fallback?.contextWindow ?? 128_000,
		maxTokens: numberValue(raw.max_output_tokens) ?? fallback?.maxTokens ?? 8_192,
		thinkingLevelMap: reasoning ? (fallback?.thinkingLevelMap ?? DEFAULT_THINKING_LEVEL_MAP) : NO_THINKING_LEVEL_MAP,
	};
}

export function clinePassModelsFromApiResponse(value: unknown): readonly Model<"openai-completions">[] {
	const rawModels = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.data)
			? value.data
			: undefined;
	if (!rawModels) throw new Error("Expected ClinePass models response to be an array or object with data array");

	const staticById = new Map(CLINEPASS_STATIC_MODELS.map((model) => [model.id, model]));
	const parsed = rawModels.flatMap((entry) => {
		if (!isRecord(entry)) return [];
		const model = parseRemoteModel(entry, staticById.get(stringValue(entry.id) ?? ""));
		return model ? [model] : [];
	});
	if (parsed.length === 0) throw new Error("Expected at least one cline-pass model");
	return parsed;
}

export async function fetchClinePassModels(options: ClinePassRemoteModelsOptions = {}) {
	const apiKey = options.apiKey ?? process.env[CLINEPASS_API_KEY_ENV];
	if (!apiKey) return CLINEPASS_STATIC_MODELS;

	const apiBase = normalizeApiBase(options.apiBase ?? process.env[CLINEPASS_API_BASE_ENV]);
	const response = await (options.fetchImpl ?? fetch)(`${apiBase}/api/v1/models`, {
		headers: { authorization: `Bearer ${apiKey}` },
	});
	if (!response.ok) return CLINEPASS_STATIC_MODELS;
	const body: unknown = await response.json();
	return clinePassModelsFromApiResponse(body);
}
