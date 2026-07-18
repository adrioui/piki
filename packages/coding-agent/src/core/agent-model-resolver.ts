import type { Api } from "@piki/ai";
import type { Model } from "@piki/ai/compat";
import { ROLE_DEFINITIONS } from "@piki/event-core";
import type { AgentSessionServices } from "./agent-session-services.ts";
import { resolvePreferredAuxModel } from "./aux-model.ts";
import { DEFAULT_ROLE_MODEL_IDS, getTierModelIds } from "./model-tier-config.ts";

export class AgentModelResolver {
	private readonly services: AgentSessionServices;
	private readonly overrides: Record<string, string>;

	constructor(services: AgentSessionServices, overrides: Record<string, string> = {}) {
		this.services = services;
		this.overrides = overrides;
	}

	resolve(roleId: string, _agentId?: string): Model<Api> | undefined {
		const available = this.services.modelRegistry.getAvailable();
		// Per-role default (alpha22 proxy map) takes precedence over tier fallback.
		// Runtime overrides are consulted first so in-session /model changes apply.
		const roleModelId = this.overrides[roleId] ?? DEFAULT_ROLE_MODEL_IDS[roleId];
		if (roleModelId) {
			const match = available.find(
				(model) => model.id === roleModelId || `${model.provider}/${model.id}` === roleModelId,
			);
			if (match) return match as Model<Api>;
		}
		const tier = ROLE_DEFINITIONS[roleId]?.tier ?? "smart";
		for (const id of getTierModelIds(tier)) {
			const match = available.find((model) => model.id === id || `${model.provider}/${model.id}` === id);
			if (match) return match as Model<Api>;
		}
		return resolvePreferredAuxModel(this.services);
	}
}
