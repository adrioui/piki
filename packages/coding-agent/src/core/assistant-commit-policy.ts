import type { AssistantMessage } from "@piki/ai/compat";
import { isContextOverflow } from "@piki/ai/compat";
import type { ErrorCategory } from "./permissions/error-classifier.ts";

export type AssistantCommitDisposition =
	| "commit"
	| "retry"
	| "compact_then_retry"
	| "terminal_error"
	| "tool_validation_retry";

export interface AssistantCommitPolicyInput {
	message: AssistantMessage;
	contextWindow: number;
	isNonRetryableProviderLimitError: (errorMessage: string) => boolean;
	isProviderApiKeyRetryable: (provider: string, category: ErrorCategory) => boolean;
	classifyError: (errorMessage: string) => { retryable: boolean; category: ErrorCategory };
}

export interface AssistantCommitPolicyDecision {
	disposition: AssistantCommitDisposition;
	retryable: boolean;
	reason: string;
}

export function decideAssistantCommit(input: AssistantCommitPolicyInput): AssistantCommitPolicyDecision {
	const { message } = input;
	if (message.stopReason !== "error" || !message.errorMessage) {
		return { disposition: "commit", retryable: false, reason: "assistant_completed" };
	}

	if (isContextOverflow(message, input.contextWindow)) {
		return { disposition: "compact_then_retry", retryable: false, reason: "context_overflow" };
	}

	if (message.errorMessage.startsWith("tool_validation:")) {
		return { disposition: "tool_validation_retry", retryable: true, reason: "tool_validation" };
	}

	if (input.isNonRetryableProviderLimitError(message.errorMessage)) {
		return { disposition: "terminal_error", retryable: false, reason: "provider_limit" };
	}

	const classification = input.classifyError(message.errorMessage);
	if (
		!classification.retryable &&
		message.provider &&
		input.isProviderApiKeyRetryable(message.provider, classification.category)
	) {
		return { disposition: "retry", retryable: true, reason: "provider_auth_fallback" };
	}

	return {
		disposition: classification.retryable ? "retry" : "terminal_error",
		retryable: classification.retryable,
		reason: classification.category,
	};
}
