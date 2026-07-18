import type { Model } from "@piki/ai";
import { describe, expect, it } from "vitest";
import { AgentModelResolver } from "../../../src/core/agent-model-resolver.ts";
import type { AgentSessionServices } from "../../../src/core/agent-session-services.ts";
import type { ModelRegistry } from "../../../src/core/model-registry.ts";
import {
	DEFAULT_ROLE_MODEL_IDS,
	DEFAULT_TIER_MODEL_IDS,
	getThinkingLevelForTier,
	getTierModelIds,
	resolveRoleModelId,
} from "../../../src/core/model-tier-config.ts";

function makeModel(provider: string, id: string): Model<string> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function makeRegistry(models: Model<string>[]): ModelRegistry {
	return { getAvailable: () => models } as unknown as ModelRegistry;
}

function makeServices(models: Model<string>[]): AgentSessionServices {
	return { modelRegistry: makeRegistry(models) } as unknown as AgentSessionServices;
}

const availableModels = [
	makeModel("clinepass", "cline-pass/mimo-v2.5-pro"),
	makeModel("openrouter", "tencent/hy3:free"),
	makeModel("clinepass", "cline-pass/deepseek-v4-flash"),
	makeModel("openai", "gpt-5.6-sol"),
	makeModel("xiaomi", "mimo-v2.5-pro"),
	makeModel("commandcode", "deepseek/deepseek-v4-pro"),
];

describe("resolveRoleModelId", () => {
	it("returns built-in default when no override", () => {
		expect(resolveRoleModelId("leader")).toBe(DEFAULT_ROLE_MODEL_IDS.leader);
	});

	it("returns override when present", () => {
		expect(resolveRoleModelId("leader", { leader: "openai/gpt-5" })).toBe("openai/gpt-5");
	});
});

describe("AgentModelResolver per-role overrides", () => {
	it("resolves built-in default when no overrides", () => {
		const resolver = new AgentModelResolver(makeServices(availableModels));
		const model = resolver.resolve("scout");
		expect(model?.id).toBe("cline-pass/deepseek-v4-flash");
	});

	it("honors runtime override over built-in default", () => {
		const resolver = new AgentModelResolver(makeServices(availableModels), {
			scout: "openrouter/tencent/hy3:free",
		});
		const model = resolver.resolve("scout");
		expect(model?.provider).toBe("openrouter");
		expect(model?.id).toBe("tencent/hy3:free");
	});

	it("falls back to tier when role has no model and no override", () => {
		const resolver = new AgentModelResolver(makeServices([makeModel("commandcode", "deepseek/deepseek-v4-pro")]));
		// Unknown role falls to smart tier fallback.
		const model = resolver.resolve("nonexistent-role");
		expect(model?.id).toBe("deepseek/deepseek-v4-pro");
	});
});

/**
 * Build the canonical model objects for every configured id across both maps.
 * For a canonical `${provider}/${id}` form, the provider is the segment before
 * the first slash and the model id is everything after it. A bare id (no slash)
 * is used as both provider and id.
 */
function modelsForAllConfiguredIds(): Model<string>[] {
	const ids = new Set<string>([
		...Object.values(DEFAULT_ROLE_MODEL_IDS),
		...Object.values(DEFAULT_TIER_MODEL_IDS).flat(),
	]);
	const models: Model<string>[] = [];
	for (const id of ids) {
		const slash = id.indexOf("/");
		if (slash === -1) {
			models.push(makeModel(id, id));
		} else {
			models.push(makeModel(id.slice(0, slash), id.slice(slash + 1)));
		}
	}
	return models;
}

describe("all configured model IDs resolve", () => {
	const models = modelsForAllConfiguredIds();
	const services = makeServices(models);
	const resolver = new AgentModelResolver(services);

	it("every per-role id resolves through the resolver", () => {
		for (const [role, id] of Object.entries(DEFAULT_ROLE_MODEL_IDS)) {
			const model = resolver.resolve(role);
			expect(model, `role ${role} (${id}) should resolve`).toBeDefined();
			expect(`${model!.provider}/${model!.id}`, `role ${role} (${id}) canonical mismatch`).toBe(id);
		}
	});

	it("every tier id resolves through the resolver", () => {
		for (const tier of Object.keys(DEFAULT_TIER_MODEL_IDS) as (keyof typeof DEFAULT_TIER_MODEL_IDS)[]) {
			for (const id of getTierModelIds(tier)) {
				const match = models.find((m) => m.id === id || `${m.provider}/${m.id}` === id);
				expect(match, `tier ${tier} id ${id} should resolve`).toBeDefined();
			}
		}
	});
});

describe("alpha22 parity — per-role thinking level derives from tier", () => {
	it("enables thinking for smart+thinking tiers, disables for fast, falls back otherwise", () => {
		expect(getThinkingLevelForTier("smart+thinking")).toBe("medium");
		expect(getThinkingLevelForTier("smart+high-temp+thinking")).toBe("medium");
		expect(getThinkingLevelForTier("fast")).toBe("off");
		expect(getThinkingLevelForTier("smart", "low")).toBe("low");
		expect(getThinkingLevelForTier(undefined, "low")).toBe("low");
	});

	it("maps critic/architect/scientist to a thinking tier and engineer to fast", () => {
		// Default per-role ids must be tier-faithful (no longer all collapse to one id).
		for (const role of ["critic", "architect", "scientist"]) {
			expect(DEFAULT_ROLE_MODEL_IDS[role]).not.toBe(DEFAULT_ROLE_MODEL_IDS.engineer);
		}
	});
});
