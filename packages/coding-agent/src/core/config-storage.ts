/**
 * ConfigStorage — Effect service wrapping ModelRegistry for context-limit resolution.
 *
 * G19: provides resolveModelConfig / resolveContextLimitPolicy (alias) backed by
 * ModelRegistry lookup + computeContextLimits (context-limit-policy.ts).
 */

import { Context, Effect, Layer } from "effect";
import { computeContextLimits, DEFAULT_MAX_OUTPUT_TOKENS } from "./context-limit-policy.ts";
import type { ModelRegistry } from "./model-registry.ts";

// ── public types ────────────────────────────────────────────────────────────────

/** Fully resolved model config including context-window caps. */
export interface ResolvedModelConfig {
	readonly modelId: string;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly reserveInputTokens: number;
	readonly hardCap: number;
	readonly softCap: number;
}

export interface ConfigStorageShape {
	readonly resolveModelConfig: (
		modelId: string,
		override?: Partial<Pick<ResolvedModelConfig, "contextWindow" | "maxOutputTokens">>,
	) => Effect.Effect<ResolvedModelConfig, ConfigResolutionError>;

	/** Alias — same computation; exists for intent-clarity at call sites. */
	readonly resolveContextLimitPolicy: (
		modelId: string,
		override?: Partial<Pick<ResolvedModelConfig, "contextWindow" | "maxOutputTokens">>,
	) => Effect.Effect<ResolvedModelConfig, ConfigResolutionError>;
}

export const ConfigStorage = Context.GenericTag<ConfigStorageShape>("ConfigStorage");

// ── error type ──────────────────────────────────────────────────────────────────

export class ConfigResolutionError extends Error {
	readonly _tag: "ConfigResolutionError";
	readonly modelId: string;
	readonly cause: unknown;

	constructor(modelId: string, cause: unknown) {
		super(`Config resolution failed for "${modelId}"`);
		this.name = "ConfigResolutionError";
		this._tag = "ConfigResolutionError";
		this.modelId = modelId;
		this.cause = cause;
	}
}

// ── model-id resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a modelId string against a ModelRegistry.
 *
 * Accepted formats:
 *   "provider/modelId" — split on first "/" and call registry.find(provider, id)
 *   "modelId"          — scan registry.getAll() for first match by id
 *
 * Returns the Model<Api> or undefined if not found.
 */
function resolveModelFromRegistry(
	registry: ModelRegistry,
	modelId: string,
): { contextWindow: number; maxTokens: number } | undefined {
	const slashIdx = modelId.indexOf("/");
	if (slashIdx > 0) {
		const provider = modelId.slice(0, slashIdx);
		const id = modelId.slice(slashIdx + 1);
		const found = registry.find(provider, id);
		if (found) return { contextWindow: found.contextWindow, maxTokens: found.maxTokens };
	}
	// Fallback: search all models by id
	for (const m of registry.getAll()) {
		if (m.id === modelId) return { contextWindow: m.contextWindow, maxTokens: m.maxTokens };
	}
	return undefined;
}

// ── layer factory ───────────────────────────────────────────────────────────────

export function makeConfigStorageLayer(modelRegistry: ModelRegistry) {
	const resolveBody = (
		modelId: string,
		override?: Partial<Pick<ResolvedModelConfig, "contextWindow" | "maxOutputTokens">>,
	): ResolvedModelConfig => {
		const base = resolveModelFromRegistry(modelRegistry, modelId);
		const contextWindow = override?.contextWindow ?? base?.contextWindow ?? 128_000;
		const maxOutputTokens = override?.maxOutputTokens ?? base?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
		return computeContextLimits({ modelId, contextWindow, maxOutputTokens });
	};

	return Layer.effect(
		ConfigStorage,
		Effect.sync(() => ({
			resolveModelConfig: (modelId, override) =>
				Effect.try({
					try: () => resolveBody(modelId, override),
					catch: (cause) => new ConfigResolutionError(modelId, cause),
				}),
			resolveContextLimitPolicy: (modelId, override) =>
				Effect.try({
					try: () => resolveBody(modelId, override),
					catch: (cause) => new ConfigResolutionError(modelId, cause),
				}),
		})),
	);
}
