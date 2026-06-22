import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { deriveModelCapabilities } from "../src/core/model-capabilities.ts";

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
		...overrides,
	};
}

describe("deriveModelCapabilities", () => {
	test("derives vision, reasoning, and long context from core model fields", () => {
		const capabilities = deriveModelCapabilities(
			makeModel({
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
			}),
		);

		expect(capabilities.vision).toBe(true);
		expect(capabilities.reasoning).toBe(true);
		expect(capabilities.longContext).toBe(true);
	});

	test("derives Anthropic-style prompt-cache capabilities", () => {
		const capabilities = deriveModelCapabilities(
			makeModel({
				api: "anthropic-messages",
				compat: {
					supportsLongCacheRetention: true,
					supportsCacheControlOnTools: false,
				},
			}),
		);

		expect(capabilities.cacheControl).toBe(true);
		expect(capabilities.longCacheRetention).toBe(true);
		expect(capabilities.toolCacheControl).toBe(false);
	});

	test("uses conservative defaults for strict and parallel tool calls", () => {
		expect(deriveModelCapabilities(makeModel()).strictTools).toBe(true);
		expect(deriveModelCapabilities(makeModel()).parallelToolCalls).toBe(true);
		expect(
			deriveModelCapabilities(
				makeModel({
					compat: { supportsStrictMode: false },
				}),
			).strictTools,
		).toBe(false);
	});
});
