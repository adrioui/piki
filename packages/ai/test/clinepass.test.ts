import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { clinePassProvider } from "../src/providers/clinepass.ts";
import { clinePassApiBase, clinePassModelsFromApiResponse } from "../src/providers/clinepass-catalog.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "cline-pass/glm-5.2",
	name: "GLM-5.2 (ClinePass)",
	api: "openai-completions",
	provider: "clinepass",
	baseUrl: "https://api.cline.bot/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 131_072,
};

describe("ClinePass provider", () => {
	it("parses provider model responses", () => {
		const models = clinePassModelsFromApiResponse({
			data: [
				{
					id: "cline-pass/test-model",
					name: "Test Model",
					context_length: 123_000,
					max_output_tokens: 12_000,
					pricing: { prompt: "0.000001", completion: "0.000002", cached_input: "0.0000001" },
					reasoning: false,
				},
				{ id: "other/model", name: "Other" },
			],
		});

		expect(models).toEqual([
			expect.objectContaining({
				id: "cline-pass/test-model",
				name: "Test Model",
				api: "openai-completions",
				provider: "clinepass",
				reasoning: false,
				contextWindow: 123_000,
				maxTokens: 12_000,
				cost: expect.objectContaining({ input: 1, output: 2, cacheWrite: 0 }),
			}),
		]);
		expect(models[0]?.cost.cacheRead).toBeCloseTo(0.1);
	});

	it("resolves auth from CLINE_API_KEY", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "CLINE_API_KEY" ? "cline_test" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(clinePassProvider());

		const auth = await models.getAuth(model);

		expect(auth).toEqual({
			auth: { apiKey: "cline_test", baseUrl: "https://api.cline.bot/api/v1" },
			source: "CLINE_API_KEY",
		});
	});

	it("resolves subscription credentials as request auth", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("clinepass", async () => ({
			type: "oauth",
			access: "workos:test",
			refresh: "refresh-test",
			expires: Date.now() + 60_000,
		}));
		const models = createModels({ credentials });
		models.setProvider(clinePassProvider());

		const auth = await models.getAuth(model);

		expect(auth).toEqual({
			auth: { apiKey: "workos:test", baseUrl: "https://api.cline.bot/api/v1" },
			source: "OAuth",
		});
	});

	it("normalizes CLINE_API_BASE", () => {
		expect(clinePassApiBase({ CLINE_API_BASE: " https://example.test/// " })).toBe("https://example.test");
		expect(clinePassApiBase({})).toBe("https://api.cline.bot");
	});
});
