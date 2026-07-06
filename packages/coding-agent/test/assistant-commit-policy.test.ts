import type { AssistantMessage } from "@piki/ai/compat";
import { describe, expect, it } from "vitest";
import { decideAssistantCommit } from "../src/core/assistant-commit-policy.ts";

function assistant(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		...overrides,
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

describe("decideAssistantCommit", () => {
	it("commits successful assistant messages", () => {
		const decision = decideAssistantCommit({
			message: assistant({ stopReason: "stop" }),
			contextWindow: 1000,
			isNonRetryableProviderLimitError: () => false,
			isProviderApiKeyRetryable: () => false,
			classifyError: () => ({ retryable: false, category: "unknown" }),
		});

		expect(decision).toMatchObject({ disposition: "commit", retryable: false });
	});

	it("routes tool validation errors to immediate retry", () => {
		const decision = decideAssistantCommit({
			message: assistant({ stopReason: "error", errorMessage: "tool_validation: bad args" }),
			contextWindow: 1000,
			isNonRetryableProviderLimitError: () => false,
			isProviderApiKeyRetryable: () => false,
			classifyError: () => ({ retryable: false, category: "client_error" }),
		});

		expect(decision).toMatchObject({ disposition: "tool_validation_retry", retryable: true });
	});

	it("does not retry provider billing limits", () => {
		const decision = decideAssistantCommit({
			message: assistant({ stopReason: "error", errorMessage: "quota exceeded" }),
			contextWindow: 1000,
			isNonRetryableProviderLimitError: () => true,
			isProviderApiKeyRetryable: () => true,
			classifyError: () => ({ retryable: true, category: "quota" }),
		});

		expect(decision).toMatchObject({ disposition: "terminal_error", retryable: false, reason: "provider_limit" });
	});
});
