/**
 * Title worker: generates a session title after the first meaningful
 * user/assistant exchange.
 *
 * - Uses an aux/fast model when available, with deterministic fallback
 * from the first user text.
 * - Persists via session_info (appendSessionInfo), never direct metadata mutation.
 * - Does not overwrite manual --name or /name.
 * - Emits title lifecycle runtime events.
 */

import type { Api, Message } from "@piki/ai";
import { type Model, streamSimple } from "@piki/ai/compat";
import type { ModelRegistry } from "./model-registry.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ReadonlySessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Events emitted by the title worker for runtime observability. */
export type TitleWorkerEvent =
	| { type: "title_generate_start"; method: "llm" | "fallback"; firstUserText: string }
	| { type: "title_generate_end"; title: string; method: "llm" | "fallback"; durationMs: number }
	| { type: "title_generate_error"; error: string; fallbackTitle: string; durationMs: number };

export interface TitleWorkerOptions {
	/** Session manager for reading session info and persisting title. */
	sessionManager: ReadonlySessionManager;
	/** Model registry for resolving the aux model and API keys. */
	modelRegistry: ModelRegistry;
	/** Settings manager for feature model overrides. */
	settingsManager: SettingsManager;
	/** Abort signal to cancel title generation. */
	signal?: AbortSignal;
	/** Callback for emitting lifecycle events. */
	onEvent?: (event: TitleWorkerEvent) => void;
}

/**
 * Generate a deterministic title from the first user text.
 * Takes the first sentence or first 80 chars, cleans it up.
 */
export function deterministicTitle(firstUserText: string): string {
	const text = firstUserText.trim();
	if (!text) return "Untitled session";

	// Try to extract first sentence
	const sentenceEnd = text.search(/[.!?\n]/);
	let title: string;
	if (sentenceEnd > 0 && sentenceEnd < 200) {
		title = text.slice(0, sentenceEnd).trim();
	} else {
		// Take first line or first 80 chars
		const firstLine = text.split("\n")[0]?.trim() ?? text;
		title = firstLine.length > 80 ? firstLine.slice(0, 80).trim() : firstLine;
	}

	// Clean up: remove leading special chars, collapse whitespace
	title = title
		.replace(/^[/\\`"'#>\-*]+/, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!title) return "Untitled session";

	// Capitalize first letter
	return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * Extract the first user message text from session entries.
 * Returns undefined if no user message is found.
 */
export function extractFirstUserText(sessionManager: ReadonlySessionManager): string | undefined {
	const entries = sessionManager.getEntries();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const textParts = content
				.filter(
					(part): part is { type: "text"; text: string } =>
						part.type === "text" && typeof (part as { text?: unknown }).text === "string",
				)
				.map((part) => part.text);
			const text = textParts.join(" ").trim();
			if (text) return text;
		}
	}
	return undefined;
}

const TITLE_GENERATION_SYSTEM_PROMPT = `Generate a short session title (2-6 words) for this conversation.
The title should capture the main topic or goal.
Return ONLY the title text, no quotes, no explanation, no punctuation at end.
Examples: "Fix login bug", "Add dark mode", "Refactor database layer"`;

const TITLE_MODEL_CANDIDATES = ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"] as const;

/**
 * Resolve the best available model for title generation.
 * Checks feature model overrides in settings, then falls back to known fast models.
 */
function resolveTitleModel(modelRegistry: ModelRegistry, settingsManager: SettingsManager): Model<Api> | undefined {
	const available = modelRegistry.getAvailable();

	// Check feature model override for "title"
	const rawSettings = (
		settingsManager as unknown as { getRawSettings?: () => Record<string, unknown> }
	).getRawSettings?.();
	const featureModels =
		rawSettings && typeof rawSettings === "object"
			? (rawSettings as Record<string, unknown>).featureModels
			: undefined;
	if (featureModels && typeof featureModels === "object") {
		const override = (featureModels as Record<string, unknown>).title;
		if (typeof override === "string") {
			const match = available.find((m) => `${m.provider}/${m.id}` === override || m.id === override);
			if (match) return match;
		}
	}

	// Try known fast models
	for (const modelId of TITLE_MODEL_CANDIDATES) {
		const match = available.find((m) => m.provider === "commandcode" && m.id === modelId);
		if (match && modelRegistry.hasConfiguredAuth(match)) return match;
	}

	// Fall back to any commandcode model with auth
	const providerMatch = available.find((m) => m.provider === "commandcode");
	if (providerMatch && modelRegistry.hasConfiguredAuth(providerMatch)) return providerMatch;

	return undefined;
}

/**
 * Try to generate a title using the LLM.
 * Returns the title string, or undefined if generation fails.
 */
async function generateTitleViaLLM(options: {
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	firstUserText: string;
	signal?: AbortSignal;
}): Promise<string | undefined> {
	const { modelRegistry, settingsManager, firstUserText, signal } = options;

	try {
		const model = resolveTitleModel(modelRegistry, settingsManager);
		if (!model) return undefined;

		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return undefined;

		const streamOptions = {
			apiKey: auth.apiKey,
			env: auth.env,
			signal,
			headers: mergeProviderAttributionHeaders(model, settingsManager, undefined, auth.headers),
		};

		const messages: Message[] = [{ role: "user", content: firstUserText, timestamp: Date.now() }];
		const stream = streamSimple(model, { systemPrompt: TITLE_GENERATION_SYSTEM_PROMPT, messages }, streamOptions);
		const result = await stream.result();

		if (result.stopReason === "error" || result.stopReason === "aborted") {
			return undefined;
		}

		const text = result.content
			.filter(
				(part): part is { type: "text"; text: string } =>
					part.type === "text" && typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join("")
			.trim();

		// Validate: must be non-empty, reasonable length, no newlines
		const cleaned = text.replace(/[\n\r]/g, " ").trim();
		if (cleaned.length > 0 && cleaned.length <= 100) {
			return cleaned;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Generate and persist a session title.
 *
 * This should be called after the first assistant response completes.
 * It will not overwrite an existing title (from --name or /name).
 */
export async function generateSessionTitle(options: TitleWorkerOptions): Promise<void> {
	const { sessionManager, modelRegistry, settingsManager, signal, onEvent } = options;

	// Check if session already has a name (from --name or /name)
	const existingName = sessionManager.getSessionName();
	if (existingName) return;

	// Extract first user text
	const firstUserText = extractFirstUserText(sessionManager);
	if (!firstUserText) return;

	let title: string;
	let method: "llm" | "fallback" = "fallback";
	const startTime = Date.now();

	// Try LLM generation
	onEvent?.({
		type: "title_generate_start",
		method: "llm",
		firstUserText,
	});

	try {
		const llmTitle = await generateTitleViaLLM({
			modelRegistry,
			settingsManager,
			firstUserText,
			signal,
		});
		if (llmTitle) {
			title = llmTitle;
			method = "llm";
		} else {
			title = deterministicTitle(firstUserText);
		}
	} catch (error) {
		title = deterministicTitle(firstUserText);
		onEvent?.({
			type: "title_generate_error",
			error: error instanceof Error ? error.message : String(error),
			fallbackTitle: title,
			durationMs: Date.now() - startTime,
		});
	}

	// Double-check: don't overwrite if title was set concurrently
	const currentName = sessionManager.getSessionName();
	if (currentName) return;

	// Persist via session_info
	// The session title is persisted as a session_info entry.
	(sessionManager as { appendSessionInfo?: (name: string) => string }).appendSessionInfo?.(title);

	const durationMs = Date.now() - startTime;
	onEvent?.({
		type: "title_generate_end",
		title,
		method,
		durationMs,
	});
}
