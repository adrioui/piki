import type { Api, Model } from "@piki/ai/compat";
import { describe, expect, test } from "vitest";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { buildConfigState, getRoleConfig, refineConfigState } from "../src/core/ambient/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DEFAULT_ROLE_MODEL_IDS } from "../src/core/model-tier-config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Build minimal services sufficient for refineConfigState (modelRegistry +
 * settingsManager are the only fields AgentModelResolver / resolvePreferredAuxModel
 * read).
 */
function makeServices(models: Model<Api>[]): AgentSessionServices {
	const registry = ModelRegistry.inMemory(authStorage);
	(registry as unknown as { models: Model<Api>[] }).models = models;
	return {
		cwd: "/tmp",
		agentDir: "/tmp",
		authStorage,
		settingsManager: SettingsManager.create("/tmp", "/tmp"),
		modelRegistry: registry,
		resourceLoader: undefined as never,
		diagnostics: [],
	} as unknown as AgentSessionServices;
}

const testModels: Model<Api>[] = [
	{
		id: "cline-pass/deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "anthropic-messages",
		provider: "clinepass",
		baseUrl: "https://api.clinepass.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: 32768,
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT 5.6 Sol",
		api: "anthropic-messages",
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 272000,
		maxTokens: 16384,
	},
];

const authStorage = AuthStorage.create("/tmp/auth.json");
// Persist api-key credentials so hasAuth()/getAvailable() report the providers as
// configured (runtime-only keys are not consulted by ModelRegistry.hasConfiguredAuth).
authStorage.set("clinepass", { type: "api_key", keys: ["test-key"] });
authStorage.set("openai", { type: "api_key", keys: ["test-key"] });

describe("ambient/config refineConfigState", () => {
	test("buildConfigState seeds fallback profiles and catalogLoaded=false", () => {
		const state = buildConfigState();
		expect(state.catalogLoaded).toBe(false);
		expect(state.byRole.leader?.profile.contextWindow).toBe(200000);
		expect(state.byRole.leader?.profile.maxOutputTokens).toBe(16384);
	});

	test("refineConfigState sets catalogLoaded=true and refines per-role caps", () => {
		const services = makeServices(testModels);
		const refined = refineConfigState(buildConfigState(), services);

		expect(refined.catalogLoaded).toBe(true);

		// scout defaults to clinepass/cline-pass/deepseek-v4-flash (256k context, 32k output)
		const scout = getRoleConfig(refined, "scout");
		expect(scout?.modelId).toBe("clinepass/cline-pass/deepseek-v4-flash");
		expect(scout?.profile.contextWindow).toBe(256000);
		expect(scout?.profile.maxOutputTokens).toBe(32768);
		expect(scout?.profile.capabilities.vision).toBe(true);
		expect(scout?.profile.capabilities.reasoning.type).toBe("model");
		// hardCap derived from 256000 context window via calculateContextCaps
		expect(scout?.hardCap).toBeLessThan(256000);
		expect(scout?.hardCap).toBeGreaterThan(0);
	});

	test("refineConfigState honors runtime role-model overrides", () => {
		const services = makeServices([
			...testModels,
			{
				id: "override-model",
				name: "Override",
				api: "anthropic-messages",
				provider: "clinepass",
				baseUrl: "https://api.clinepass.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		]);
		const refined = refineConfigState(buildConfigState(), services, {
			scout: "clinepass/override-model",
		});
		const scout = getRoleConfig(refined, "scout");
		expect(scout?.modelId).toBe("clinepass/override-model");
		expect(scout?.profile.contextWindow).toBe(128000);
	});

	test("refineConfigState falls back to fallback profile when no model resolves", () => {
		const services = makeServices([]);
		const refined = refineConfigState(buildConfigState(), services);
		expect(refined.catalogLoaded).toBe(true);
		const leader = getRoleConfig(refined, "leader");
		// No model for leader resolves -> keeps fallback 200k/16k profile.
		expect(leader?.profile.contextWindow).toBe(200000);
		expect(leader?.profile.maxOutputTokens).toBe(16384);
	});

	test("refineConfigState resolves every role in DEFAULT_ROLE_MODEL_IDS", () => {
		const services = makeServices(testModels);
		const refined = refineConfigState(buildConfigState(), services);
		for (const roleId of Object.keys(DEFAULT_ROLE_MODEL_IDS)) {
			const config = getRoleConfig(refined, roleId);
			expect(config, `role ${roleId} should have a config`).toBeDefined();
		}
	});
});
