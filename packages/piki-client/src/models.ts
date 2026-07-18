import { type ModelSpec, NativeChatCompletions, Option3 } from "@piki/ai";
import { classifyPikiRejectedResponse } from "./errors.ts";

/**
 * Model spec factories for the piki server client.
 */

export interface BoundPikiModel {
	spec: ModelSpec;
	stream: (
		prompt: unknown,
		tools: unknown,
		callOptions: Record<string, unknown>,
	) => import("effect").Effect.Effect<unknown, unknown, unknown>;
}

export function toModelProfile(info: { contextWindow: number; maxOutputTokens: number; capabilities: unknown }) {
	return {
		contextWindow: info.contextWindow,
		maxOutputTokens: info.maxOutputTokens,
		capabilities: info.capabilities,
	};
}

export function createPikiCompatibleSpec(config: { modelId: string; endpoint: string }) {
	return NativeChatCompletions.model({
		modelId: config.modelId,
		endpoint: config.endpoint,
		classifyRejectedResponse: classifyPikiRejectedResponse,
	});
}

export function createRoleSpec(
	roleId: string,
	endpoint: string,
	capabilities?: { vision?: boolean; grammar?: boolean },
) {
	return NativeChatCompletions.model({
		modelId: `role/${roleId}`,
		endpoint,
		classifyRejectedResponse: classifyPikiRejectedResponse,
		capabilities,
	});
}

export function bindWithPikiOptions(model: BoundPikiModel, baseOptions: unknown) {
	return {
		...model,
		stream: (prompt: unknown, tools: unknown, callOptions?: Record<string, unknown>) =>
			model.stream(prompt, tools, {
				...(callOptions as Record<string, unknown> | undefined),
				pikiAdditionalOptions: {
					...(baseOptions as Record<string, unknown> | undefined),
					...(callOptions as { pikiAdditionalOptions?: Record<string, unknown> } | undefined)
						?.pikiAdditionalOptions,
				},
			}),
	};
}

export const pikiOptions: {
	maxTokens: OptionDef;
	toolChoice: OptionDef;
	pikiAdditionalOptions: OptionDef;
} = {
	maxTokens: NativeChatCompletions.options.maxTokens as OptionDef,
	toolChoice: Option3.define((v: string) => ({ tool_choice: v })),
	pikiAdditionalOptions: Option3.define((v: unknown) => ({ piki_additional_options: v })),
};

interface OptionDef {
	_tag: "OptionDef";
}
