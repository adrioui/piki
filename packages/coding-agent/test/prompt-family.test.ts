import { describe, expect, test } from "vitest";
import {
	classifyModelLineage,
	classifyPromptProfile,
	classifyPromptVariant,
	isOpenSourceExplicitProfile,
	isOpenSourceExplicitVariant,
	type ModelLineage,
	resolvePromptProfile,
	resolvePromptVariant,
} from "../src/core/prompt-family.ts";

describe("classifyModelLineage", () => {
	describe("lineage from model-id fragments (primary signal)", () => {
		test("GLM ids on any provider", () => {
			expect(classifyModelLineage("zai", "glm-5.1", "GLM-5.1")).toBe("glm");
			expect(classifyModelLineage("zai-coding-cn", "glm-5.1", "GLM-5.1")).toBe("glm");
			expect(classifyModelLineage("openrouter", "zai/glm-5.1", "GLM-5.1")).toBe("glm");
			expect(classifyModelLineage("vercel-ai-gateway", "zai/glm-5.1", "GLM-5.1")).toBe("glm");
			expect(classifyModelLineage("together", "zai-org/GLM-5.1-FP8", "GLM-5.1 FP8")).toBe("glm");
			expect(classifyModelLineage("cerebras", "zai-glm-4.7", "GLM-4.7")).toBe("glm");
		});

		test("gpt-oss ids route as gpt-oss lineage, even on the OpenAI provider", () => {
			expect(classifyModelLineage("openai", "gpt-oss-120b", "GPT-OSS 120B")).toBe("gpt-oss");
			expect(classifyModelLineage("openai", "gpt-oss-20b", "GPT-OSS 20B")).toBe("gpt-oss");
			expect(classifyModelLineage("groq", "openai/gpt-oss-120b", "GPT-OSS 120B")).toBe("gpt-oss");
		});

		test("qwen / llama / mistral / deepseek / gemma / kimi ids", () => {
			expect(classifyModelLineage("ollama", "qwen2.5-coder", "Qwen2.5 Coder")).toBe("qwen");
			expect(classifyModelLineage("lmstudio", "Meta-Llama-3.1-70B", "Llama 3.1 70B")).toBe("llama");
			expect(classifyModelLineage("mistral", "devstral-medium-latest", "Devstral Medium")).toBe("mistral");
			expect(classifyModelLineage("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro")).toBe("deepseek");
			expect(classifyModelLineage("huggingface", "google/gemma-2-9b", "Gemma 2 9B")).toBe("gemma");
			expect(classifyModelLineage("moonshotai", "kimi-k2.6", "Kimi K2.6")).toBe("kimi");
			expect(classifyModelLineage("openrouter", "moonshotai/kimi-k2.6", "Kimi K2.6")).toBe("kimi");
		});
	});

	describe("amazon-bedrock hosted mixed lineages (id fragment wins, not provider)", () => {
		test("classifies Bedrock-hosted DeepSeek/Gemma/Llama/Mistral/Qwen/GPT-OSS by id, not as Claude", () => {
			expect(classifyModelLineage("amazon-bedrock", "deepseek.r1", "DeepSeek R1")).toBe("deepseek");
			expect(classifyModelLineage("amazon-bedrock", "google.gemma-2-9b", "Gemma 2 9B")).toBe("gemma");
			expect(classifyModelLineage("amazon-bedrock", "meta.llama3-405b", "Llama 3 405B")).toBe("llama");
			expect(classifyModelLineage("amazon-bedrock", "mistral.mistral-large", "Mistral Large")).toBe("mistral");
			expect(classifyModelLineage("amazon-bedrock", "qwen.qwen-2.5-coder", "Qwen 2.5 Coder")).toBe("qwen");
			expect(classifyModelLineage("amazon-bedrock", "openai.gpt-oss-120b", "GPT-OSS 120B")).toBe("gpt-oss");
			// GLM via id fragment even on bedrock
			expect(classifyModelLineage("amazon-bedrock", "vendor.glm-5.1", "GLM-5.1")).toBe("glm");
		});

		test("bedrock Claude models still classify as claude", () => {
			expect(classifyModelLineage("amazon-bedrock", "us.anthropic.claude-opus-4-6-v1", "Claude Opus 4")).toBe(
				"claude",
			);
			expect(classifyModelLineage("amazon-bedrock", "anthropic.claude-sonnet-4-5", "Claude Sonnet 4.5")).toBe(
				"claude",
			);
		});
	});

	describe("provider is NOT part of fragment matching", () => {
		test("provider name that looks like a lineage must not classify via the provider when id/name are opaque", () => {
			// Provider "mistral" with an opaque id/name and no lineage fragment must
			// NOT become mistral via the fragment haystack. mistral is also not in
			// the provider fallback, so this is "unknown".
			expect(classifyModelLineage("mistral", "some-opaque-id", "Opaque Model")).toBe("unknown");
		});

		test("provider string is ignored for fragment matching", () => {
			// openrouter + "openai/gpt-4o": provider "openrouter" is not matched,
			// and the id "openai/gpt-4o" has no lineage fragment (no gpt-oss), so
			// this is unknown, not openai.
			expect(classifyModelLineage("openrouter", "openai/gpt-4o", "GPT-4o")).toBe("unknown");
			// But a claude id fragment still wins regardless of provider.
			expect(classifyModelLineage("openrouter", "anthropic/claude-foo", "Claude Foo")).toBe("claude");
		});
	});

	describe("model name carries lineage when id is opaque", () => {
		test("zai + opaque id but model name GLM-5.2 => glm", () => {
			expect(classifyModelLineage("zai", "chat", "GLM-5.2")).toBe("glm");
		});

		test("openai + gpt-5.* => openai (default), not gpt-oss", () => {
			expect(classifyModelLineage("openai", "gpt-5.4", "GPT-5.4")).toBe("openai");
		});
	});

	describe("provider fallback (only when id+name have no lineage fragment)", () => {
		test("anthropic/openai/google/zai/moonshot providers fall back to their lineage", () => {
			expect(classifyModelLineage("anthropic", "claude-opus-4-8", "Claude Opus 4.8")).toBe("claude");
			expect(classifyModelLineage("openai", "gpt-5.4", "GPT-5.4")).toBe("openai");
			expect(classifyModelLineage("azure-openai-responses", "gpt-5.4", "GPT-5.4")).toBe("openai");
			expect(classifyModelLineage("openai-codex", "gpt-5.5", "GPT-5.5")).toBe("openai");
			expect(classifyModelLineage("google", "gemini-3.1-pro-preview", "Gemini 3.1 Pro")).toBe("gemini");
			expect(classifyModelLineage("google-vertex", "gemini-3.1-pro-preview", "Gemini 3.1 Pro")).toBe("gemini");
			expect(classifyModelLineage("zai", "chat", "Chat")).toBe("glm");
			expect(classifyModelLineage("zai-coding-cn", "chat", "Chat")).toBe("glm");
			expect(classifyModelLineage("moonshotai-cn", "k2", "K2")).toBe("kimi");
			expect(classifyModelLineage("kimi-coding", "for-coding", "For Coding")).toBe("kimi");
		});

		test("non-dedicated providers with unrecognizable ids fall through to unknown", () => {
			expect(classifyModelLineage("ant-ling", "Ring-2.6-1T", "Ring 2.6")).toBe("unknown");
			expect(classifyModelLineage("some-unknown-provider", "weird-model", "Weird Model")).toBe("unknown");
			expect(classifyModelLineage(undefined, undefined, undefined)).toBe("unknown");
		});
	});

	describe("case insensitivity", () => {
		test("classifies regardless of provider/model case", () => {
			expect(classifyModelLineage("Anthropic", "Claude-Opus", "Claude Opus")).toBe("claude");
			expect(classifyModelLineage("ZAI", "GLM-5.1", "GLM-5.1")).toBe("glm");
			expect(classifyModelLineage("OpenAI", "GPT-OSS-120b", "GPT-OSS 120B")).toBe("gpt-oss");
			expect(classifyModelLineage("AMAZON-BEDROCK", "META.LLAMA3-405B", "LLAMA 3 405B")).toBe("llama");
		});
	});
});

describe("resolvePromptProfile", () => {
	test("open-source lineages route to open-source-explicit", () => {
		for (const lineage of ["glm", "qwen", "llama", "mistral", "deepseek", "gemma", "gpt-oss", "kimi"] as const) {
			expect(resolvePromptProfile(lineage)).toBe("open-source-explicit");
		}
	});

	test("closed/unknown lineages keep the default prompt", () => {
		for (const lineage of ["claude", "openai", "gemini", "unknown", undefined] as const) {
			expect(resolvePromptProfile(lineage as ModelLineage | undefined)).toBe("default");
		}
	});
});

describe("classifyPromptProfile (end-to-end)", () => {
	test("bedrock open-source models get the explicit profile, not default/Claude", () => {
		expect(classifyPromptProfile("amazon-bedrock", "deepseek.r1", "DeepSeek R1")).toBe("open-source-explicit");
		expect(classifyPromptProfile("amazon-bedrock", "google.gemma-2-9b", "Gemma 2 9B")).toBe("open-source-explicit");
		expect(classifyPromptProfile("amazon-bedrock", "meta.llama3-405b", "Llama 3 405B")).toBe("open-source-explicit");
		expect(classifyPromptProfile("amazon-bedrock", "mistral.mistral-large", "Mistral Large")).toBe(
			"open-source-explicit",
		);
		expect(classifyPromptProfile("amazon-bedrock", "qwen.qwen-2.5-coder", "Qwen 2.5 Coder")).toBe(
			"open-source-explicit",
		);
		expect(classifyPromptProfile("amazon-bedrock", "openai.gpt-oss-120b", "GPT-OSS 120B")).toBe(
			"open-source-explicit",
		);
	});

	test("openai provider gpt-oss model routes as explicit (lineage beats provider)", () => {
		expect(classifyPromptProfile("openai", "gpt-oss-120b", "GPT-OSS 120B")).toBe("open-source-explicit");
	});

	test("openai + gpt-5.* stays default", () => {
		expect(classifyPromptProfile("openai", "gpt-5.4", "GPT-5.4")).toBe("default");
	});

	test("zai opaque id + GLM name routes to explicit", () => {
		expect(classifyPromptProfile("zai", "chat", "GLM-5.2")).toBe("open-source-explicit");
	});

	test("Kimi K2.x routes to explicit via id fragment on any provider, and via dedicated providers", () => {
		// id fragment
		expect(classifyPromptProfile("moonshotai", "kimi-k2", "Kimi K2")).toBe("open-source-explicit");
		expect(classifyPromptProfile("moonshotai", "kimi-k2.5", "Kimi K2.5")).toBe("open-source-explicit");
		expect(classifyPromptProfile("moonshotai", "kimi-k2.6", "Kimi K2.6")).toBe("open-source-explicit");
		expect(classifyPromptProfile("huggingface", "moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code")).toBe(
			"open-source-explicit",
		);
		// openrouter hosted kimi
		expect(classifyPromptProfile("openrouter", "moonshotai/kimi-k2.6", "Kimi K2.6")).toBe("open-source-explicit");
		// dedicated providers via provider fallback
		expect(classifyPromptProfile("moonshotai-cn", "k2", "K2")).toBe("open-source-explicit");
		expect(classifyPromptProfile("kimi-coding", "for-coding", "For Coding")).toBe("open-source-explicit");
	});

	test("Claude/OpenAI/Gemini default models keep the default prompt", () => {
		expect(classifyPromptProfile("anthropic", "claude-opus-4-8", "Claude Opus 4.8")).toBe("default");
		expect(classifyPromptProfile("amazon-bedrock", "us.anthropic.claude-opus-4-6-v1", "Claude Opus 4")).toBe(
			"default",
		);
		expect(classifyPromptProfile("openai", "gpt-5.4", "GPT-5.4")).toBe("default");
		expect(classifyPromptProfile("google", "gemini-3.1-pro-preview", "Gemini 3.1 Pro")).toBe("default");
	});

	test("unknown lineage keeps default", () => {
		expect(classifyPromptProfile(undefined, undefined, undefined)).toBe("default");
	});
});

describe("isOpenSourceExplicitProfile", () => {
	test("true only for open-source-explicit", () => {
		expect(isOpenSourceExplicitProfile("open-source-explicit")).toBe(true);
		expect(isOpenSourceExplicitProfile("default")).toBe(false);
		expect(isOpenSourceExplicitProfile(undefined)).toBe(false);
	});
});

describe("resolvePromptVariant", () => {
	test("kimi lineage routes to kimi-explicit", () => {
		expect(resolvePromptVariant("kimi")).toBe("kimi-explicit");
	});

	test("grok lineage routes to grok-explicit", () => {
		expect(resolvePromptVariant("grok")).toBe("grok-explicit");
	});

	test("openai lineage routes to openai-explicit", () => {
		expect(resolvePromptVariant("openai")).toBe("openai-explicit");
	});

	test("gemini lineage routes to gemini-explicit", () => {
		expect(resolvePromptVariant("gemini")).toBe("gemini-explicit");
	});

	test("open-source lineages route to open-source-explicit", () => {
		for (const lineage of ["glm", "qwen", "llama", "mistral", "deepseek", "gemma", "gpt-oss"] as const) {
			expect(resolvePromptVariant(lineage)).toBe("open-source-explicit");
		}
	});

	test("claude/unknown lineages route to default", () => {
		expect(resolvePromptVariant("claude")).toBe("default");
		expect(resolvePromptVariant("unknown")).toBe("default");
		expect(resolvePromptVariant(undefined)).toBe("default");
	});
});

describe("classifyPromptVariant (end-to-end)", () => {
	test("Kimi K2.x routes to kimi-explicit", () => {
		expect(classifyPromptVariant("moonshotai", "kimi-k2.6", "Kimi K2.6")).toBe("kimi-explicit");
		expect(classifyPromptVariant("openrouter", "moonshotai/kimi-k2.6", "Kimi K2.6")).toBe("kimi-explicit");
	});

	test("xAI/Grok routes to grok-explicit", () => {
		expect(classifyPromptVariant("xai", "grok-3", "Grok 3")).toBe("grok-explicit");
	});

	test("OpenAI GPT routes to openai-explicit", () => {
		expect(classifyPromptVariant("openai", "gpt-5.5", "GPT-5.5")).toBe("openai-explicit");
		expect(classifyPromptVariant("openai-codex", "gpt-5.5-codex", "GPT-5.5 Codex")).toBe("openai-explicit");
	});

	test("Google Gemini routes to gemini-explicit", () => {
		expect(classifyPromptVariant("google", "gemini-3.1-pro", "Gemini 3.1 Pro")).toBe("gemini-explicit");
		expect(classifyPromptVariant("google-vertex", "gemini-3.1-pro", "Gemini 3.1 Pro")).toBe("gemini-explicit");
	});

	test("Open-source models route to open-source-explicit", () => {
		expect(classifyPromptVariant("zai", "glm-5.2", "GLM-5.2")).toBe("open-source-explicit");
		expect(classifyPromptVariant("ollama", "qwen2.5-coder", "Qwen2.5 Coder")).toBe("open-source-explicit");
		expect(classifyPromptVariant("lmstudio", "llama-3.1-70b", "Llama 3.1")).toBe("open-source-explicit");
		expect(classifyPromptVariant("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro")).toBe("open-source-explicit");
	});

	test("Claude routes to default", () => {
		expect(classifyPromptVariant("anthropic", "claude-opus-4-8", "Claude Opus 4.8")).toBe("default");
		expect(classifyPromptVariant("openrouter", "anthropic/claude-opus-4-8", "Claude Opus 4.8")).toBe("default");
	});

	test("Unknown models route to default", () => {
		expect(classifyPromptVariant(undefined, undefined, undefined)).toBe("default");
	});
});

describe("isOpenSourceExplicitVariant", () => {
	test("true only for open-source-explicit", () => {
		expect(isOpenSourceExplicitVariant("open-source-explicit")).toBe(true);
		expect(isOpenSourceExplicitVariant("default")).toBe(false);
		expect(isOpenSourceExplicitVariant("kimi-explicit")).toBe(false);
		expect(isOpenSourceExplicitVariant("openai-explicit")).toBe(false);
		expect(isOpenSourceExplicitVariant(undefined)).toBe(false);
	});
});
