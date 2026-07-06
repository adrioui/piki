import type { Model } from "../types.ts";

export const COMMANDCODE_BASE_URL = "https://api.commandcode.ai";
export const COMMANDCODE_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

interface CommandCodeApiModel {
	id: string;
	name: string;
	contextLength: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new Error(`Expected ${key} to be a string`);
	return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number") throw new Error(`Expected ${key} to be a number`);
	return value;
}

function parseApiModel(value: unknown): CommandCodeApiModel {
	if (!isRecord(value)) throw new Error("Expected model entry to be an object");
	return {
		id: stringField(value, "id"),
		name: stringField(value, "name"),
		contextLength: numberField(value, "context_length"),
	};
}

export function commandCodeModelsFromApiResponse(value: unknown): readonly Model<"commandcode">[] {
	if (!isRecord(value)) throw new Error("Expected models response to be an object");
	if (value.object !== "list") throw new Error("Expected models response object to be 'list'");
	if (!Array.isArray(value.data)) throw new Error("Expected models response data to be an array");

	return value.data.map(parseApiModel).map((model) => ({
		id: model.id,
		name: `${model.name} (Command Code)`,
		api: "commandcode",
		provider: "commandcode",
		baseUrl: COMMANDCODE_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextLength,
		maxTokens: Math.min(model.contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
	}));
}

export async function fetchCommandCodeModels(options: { url?: string; fetchImpl?: typeof fetch } = {}) {
	const response = await (options.fetchImpl ?? fetch)(options.url ?? COMMANDCODE_MODELS_URL, {
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch Command Code models: ${response.status} ${response.statusText}`);
	}
	const body: unknown = await response.json();
	return commandCodeModelsFromApiResponse(body);
}

export const COMMANDCODE_STATIC_MODELS = commandCodeModelsFromApiResponse({
	object: "list",
	data: [
		{ id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 1_000_000 },
		{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 1_000_000 },
		{ id: "claude-opus-4-8", name: "Claude Opus 4.8", context_length: 1_000_000 },
		{ id: "gpt-5.5", name: "GPT-5.5", context_length: 200_000 },
		{ id: "gpt-5.4", name: "GPT-5.4", context_length: 400_000 },
		{ id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code", context_length: 256_000 },
		{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", context_length: 1_000_000 },
	],
});
