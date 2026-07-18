import type { Api, ImageContent, Message, Model, TextContent } from "@piki/ai";
import { streamSimple } from "@piki/ai/compat";
import type { AgentSessionServices } from "./agent-session-services.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import { streamSimpleWithApiKeyResolver } from "./sdk.ts";

const DEFAULT_COMMANDCODE_MODELS = ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"] as const;
const FALLBACK_OPENCODE_GO_MODELS = ["deepseek-v4-pro", "kimi-k2.6", "kimi-k2.5"] as const;

export function extractAssistantText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("")
		.trim();
}

export function resolvePreferredAuxModel(
	services: AgentSessionServices,
	preferredModel?: Model<any>,
	provider = "commandcode",
	feature?: string,
): Model<Api> | undefined {
	const available = services.modelRegistry.getAvailable();
	const featureModels = (
		services.settingsManager as unknown as { getRawSettings?: () => { featureModels?: Record<string, string> } }
	).getRawSettings?.()?.featureModels;
	const featureModel = feature ? featureModels?.[feature] : undefined;
	if (featureModel) {
		const match = available.find(
			(candidate) => `${candidate.provider}/${candidate.id}` === featureModel || candidate.id === featureModel,
		);
		if (match) return match;
	}
	if (
		preferredModel &&
		preferredModel.provider === provider &&
		services.modelRegistry.hasConfiguredAuth(preferredModel)
	) {
		return preferredModel as Model<Api>;
	}
	for (const modelId of DEFAULT_COMMANDCODE_MODELS) {
		const match = available.find((candidate) => candidate.provider === provider && candidate.id === modelId);
		if (match) return match;
	}
	const providerMatch = available.find((candidate) => candidate.provider === provider);
	if (providerMatch) return providerMatch;
	for (const modelId of FALLBACK_OPENCODE_GO_MODELS) {
		const match = available.find((candidate) => candidate.provider === "opencode-go" && candidate.id === modelId);
		if (match) return match;
	}
	return available.find((candidate) => candidate.provider === "opencode-go");
}

export async function runAuxModelText(options: {
	services: AgentSessionServices;
	messages: Message[];
	systemPrompt: string;
	model?: Model<Api>;
	sessionId?: string;
	signal?: AbortSignal;
}): Promise<string> {
	const model = options.model ?? resolvePreferredAuxModel(options.services);
	if (!model) {
		throw new Error('No configured model available for "commandcode/deepseek/deepseek-v4-pro"');
	}

	const auth = await options.services.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}

	const streamOptions = {
		apiKey: auth.apiKey,
		env: auth.env,
		signal: options.signal,
		headers: mergeProviderAttributionHeaders(
			model,
			options.services.settingsManager,
			options.sessionId,
			auth.headers,
		),
	};
	const context = {
		systemPrompt: options.systemPrompt,
		messages: options.messages,
	};
	const stream = auth.apiKeyResolver
		? streamSimpleWithApiKeyResolver(model, context, streamOptions, auth.apiKeyResolver)
		: streamSimple(model, context, streamOptions);
	const result = await stream.result();
	if (result.stopReason === "error") {
		throw new Error(result.errorMessage ?? "Provider returned an error");
	}
	if (result.stopReason === "aborted") {
		throw new Error("Provider request aborted");
	}
	const text = extractAssistantText(result.content);
	if (!text) {
		// Some models (e.g. DeepSeek V4) output their response entirely in the thinking
		// block and leave the text block empty. Fall back to the last thinking block.
		for (const part of result.content) {
			if (part.type === "thinking" && "thinking" in part && typeof part.thinking === "string") {
				const trimmed = part.thinking.trim();
				if (trimmed) return trimmed;
			}
		}
	}
	return text;
}

/** Minimal services needed to resolve and query a vision model. */
interface VisionModelServices {
	modelRegistry: AgentSessionServices["modelRegistry"];
	settingsManager: AgentSessionServices["settingsManager"];
}

/** Resolve the configured vision-capable model for image inspection. */
export function resolveVisionModel(services: VisionModelServices): Model<Api> | undefined {
	const available = services.modelRegistry.getAvailable();
	const featureModels = services.settingsManager.getRawSettings().featureModels;
	const override = featureModels?.queryImage;
	if (override) {
		const match = available.find(
			(candidate) => `${candidate.provider}/${candidate.id}` === override || candidate.id === override,
		);
		if (match) return match;
	}
	return available.find((model) => model.input.includes("image") && services.modelRegistry.hasConfiguredAuth(model));
}

/** Send an image and question to a vision-capable model and return its text response. */
export async function queryVisionModel(
	services: VisionModelServices,
	imageBase64: string,
	mimeType: string,
	query: string,
): Promise<string> {
	const model = resolveVisionModel(services);
	if (!model) {
		throw new Error("query_image tool is not connected to a vision model");
	}
	const auth = await services.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);

	const image: ImageContent = {
		type: "image",
		data: imageBase64,
		mimeType,
	};
	const text: TextContent = { type: "text", text: query };
	const messages: Message[] = [
		{
			role: "user",
			content: [image, text],
			timestamp: Date.now(),
		},
	];
	const streamOptions = {
		apiKey: auth.apiKey,
		env: auth.env,
		signal: undefined,
		headers: mergeProviderAttributionHeaders(model, services.settingsManager, undefined, auth.headers),
	};
	const context = { systemPrompt: "", messages };
	const stream = auth.apiKeyResolver
		? streamSimpleWithApiKeyResolver(model, context, streamOptions, auth.apiKeyResolver)
		: streamSimple(model, context, streamOptions);
	const result = await stream.result();
	if (result.stopReason === "error") {
		throw new Error(result.errorMessage ?? "Provider returned an error");
	}
	if (result.stopReason === "aborted") {
		throw new Error("Provider request aborted");
	}
	return extractAssistantText(result.content);
}
