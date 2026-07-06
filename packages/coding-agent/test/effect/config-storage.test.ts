/**
 * Tests for G19 ConfigStorage service.
 */

import { calculateContextCaps, OUTPUT_TOKEN_RESERVE } from "@piki/event-core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ConfigResolutionError, ConfigStorage, makeConfigStorageLayer } from "../../src/core/config-storage.ts";
import {
	compactionTriggerThreshold,
	computeContextLimits,
	DEFAULT_MAX_OUTPUT_TOKENS,
} from "../../src/core/context-limit-policy.ts";

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Minimal ModelRegistry stub for testing. */
function makeStubRegistry(models: Array<{ id: string; provider: string; contextWindow: number; maxTokens: number }>) {
	return {
		find(provider: string, modelId: string) {
			return models.find((m) => m.provider === provider && m.id === modelId) ?? undefined;
		},
		getAll() {
			return models;
		},
	} as unknown as import("../../src/core/model-registry.ts").ModelRegistry;
}

const STUB_MODELS = [
	{ id: "claude-sonnet-4-20250514", provider: "anthropic", contextWindow: 200_000, maxTokens: 16_384 },
	{ id: "gpt-4o", provider: "openai", contextWindow: 128_000, maxTokens: 16_384 },
];

// ── unit tests for computeContextLimits ─────────────────────────────────────────

describe("computeContextLimits", () => {
	it("correctly computes caps for a standard 128k model", () => {
		const rc = computeContextLimits({ modelId: "m", contextWindow: 128_000, maxOutputTokens: 8192 });
		const { hardCap, softCap } = calculateContextCaps(128_000);

		expect(rc.contextWindow).toBe(128_000);
		expect(rc.maxOutputTokens).toBe(8192);
		expect(rc.reserveInputTokens).toBe(OUTPUT_TOKEN_RESERVE);
		expect(rc.hardCap).toBe(hardCap); // max(0, 128000 - 8192) = 119808
		expect(rc.softCap).toBe(softCap); // min(floor(119808 * 0.9), 200000) = 107827
	});

	it("softCap is capped at 200_000 for large context windows", () => {
		const rc = computeContextLimits({ modelId: "m", contextWindow: 1_000_000, maxOutputTokens: 8192 });
		const { hardCap } = calculateContextCaps(1_000_000);
		// hardCap = 1_000_000 - 8192 = 991808
		// softCap = min(floor(991808 * 0.9), 200000) = 200000
		expect(rc.hardCap).toBe(hardCap);
		expect(rc.softCap).toBe(200_000);
	});

	it("hardCap is 0 when contextWindow <= OUTPUT_TOKEN_RESERVE", () => {
		const rc = computeContextLimits({ modelId: "m", contextWindow: 4096, maxOutputTokens: 4096 });
		expect(rc.hardCap).toBe(0);
		expect(rc.softCap).toBe(0);
	});

	it("compactionTriggerThreshold returns softCap", () => {
		const rc = computeContextLimits({ modelId: "m", contextWindow: 128_000, maxOutputTokens: 8192 });
		expect(compactionTriggerThreshold(rc)).toBe(rc.softCap);
	});
});

// ── Effect service tests for ConfigStorage ──────────────────────────────────────

describe("ConfigStorage Effect service", () => {
	function provideConfigStorage(registry = makeStubRegistry(STUB_MODELS)) {
		return makeConfigStorageLayer(registry);
	}

	it("resolves a model from registry using provider/model format", async () => {
		const program = Effect.gen(function* () {
			const cs = yield* ConfigStorage;
			const rc = yield* cs.resolveModelConfig("anthropic/claude-sonnet-4-20250514");
			return rc;
		});

		const rc = await Effect.runPromise(program.pipe(Effect.provide(provideConfigStorage())));

		expect(rc.modelId).toBe("anthropic/claude-sonnet-4-20250514");
		expect(rc.contextWindow).toBe(200_000);
		expect(rc.maxOutputTokens).toBe(16_384);
		expect(rc.reserveInputTokens).toBe(OUTPUT_TOKEN_RESERVE);
		expect(rc.hardCap).toBe(200_000 - OUTPUT_TOKEN_RESERVE);
		expect(rc.softCap).toBe(Math.min(Math.floor((200_000 - OUTPUT_TOKEN_RESERVE) * 0.9), 200_000));
	});

	it("resolves a model by plain modelId fallback", async () => {
		const program = Effect.gen(function* () {
			const cs = yield* ConfigStorage;
			const rc = yield* cs.resolveModelConfig("gpt-4o");
			return rc;
		});

		const rc = await Effect.runPromise(program.pipe(Effect.provide(provideConfigStorage())));

		expect(rc.modelId).toBe("gpt-4o");
		expect(rc.contextWindow).toBe(128_000);
	});

	it("override contextWindow works", async () => {
		const program = Effect.gen(function* () {
			const cs = yield* ConfigStorage;
			const rc = yield* cs.resolveModelConfig("anthropic/claude-sonnet-4-20250514", {
				contextWindow: 100_000,
			});
			return rc;
		});

		const rc = await Effect.runPromise(program.pipe(Effect.provide(provideConfigStorage())));

		expect(rc.contextWindow).toBe(100_000);
		const { hardCap, softCap } = calculateContextCaps(100_000);
		expect(rc.hardCap).toBe(hardCap);
		expect(rc.softCap).toBe(softCap);
	});

	it("override maxOutputTokens works", async () => {
		const program = Effect.gen(function* () {
			const cs = yield* ConfigStorage;
			const rc = yield* cs.resolveModelConfig("gpt-4o", { maxOutputTokens: 4096 });
			return rc;
		});

		const rc = await Effect.runPromise(program.pipe(Effect.provide(provideConfigStorage())));

		expect(rc.maxOutputTokens).toBe(4096);
	});

	it("falls back to defaults for unknown model", async () => {
		const program = Effect.gen(function* () {
			const cs = yield* ConfigStorage;
			const rc = yield* cs.resolveModelConfig("unknown/nonexistent-model");
			return rc;
		});

		const rc = await Effect.runPromise(program.pipe(Effect.provide(provideConfigStorage())));

		expect(rc.contextWindow).toBe(128_000); // default
		expect(rc.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS); // 8192
	});

	it("resolveContextLimitPolicy is an alias for resolveModelConfig", async () => {
		const program = Effect.gen(function* () {
			const cs = yield* ConfigStorage;
			const rc1 = yield* cs.resolveModelConfig("gpt-4o");
			const rc2 = yield* cs.resolveContextLimitPolicy("gpt-4o");
			return { rc1, rc2 };
		});

		const { rc1, rc2 } = await Effect.runPromise(program.pipe(Effect.provide(provideConfigStorage())));

		expect(rc1).toEqual(rc2);
	});

	it("ConfigResolutionError has correct shape", () => {
		const err = new ConfigResolutionError("test-model", new Error("boom"));
		expect(err._tag).toBe("ConfigResolutionError");
		expect(err.modelId).toBe("test-model");
		expect(err.cause).toBeInstanceOf(Error);
	});
});
