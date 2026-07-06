import { calculateCost } from "../models.ts";
import { COMMANDCODE_BASE_URL } from "../providers/commandcode-catalog.ts";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	ProviderResponse,
	SimpleStreamOptions,
	StopReason,
	StreamOptions,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

export interface CommandCodeOptions extends StreamOptions {}

const COMMAND_CODE_CLI_VERSION = "0.29.0";
const DEFAULT_GENERATE_MAX_TOKENS = 64_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const BASE_RETRY_DELAY_MS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordArray(value: unknown): readonly Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed)) return parsed;
		} catch {}
	}
	return {};
}

function defaultUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function emptyAssistant(model: Model<"commandcode">, stopReason: StopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: defaultUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function abortError(message = "The operation was aborted"): DOMException {
	return new DOMException(message, "AbortError");
}

function timeoutError(timeoutMs: number | undefined): Error {
	return new Error(
		timeoutMs === undefined
			? "Command Code API request timed out"
			: `Command Code API request timed out after ${timeoutMs}ms`,
	);
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status < 600);
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds;
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null, maxDelayMs: number): number {
	const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader);
	if (retryAfterSeconds !== undefined) {
		const retryAfterMs = retryAfterSeconds * 1000;
		return retryAfterMs > maxDelayMs ? -1 : retryAfterMs;
	}
	const exponential = BASE_RETRY_DELAY_MS * 2 ** attempt;
	return Math.min(exponential + exponential * 0.2 * Math.random(), maxDelayMs);
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

function commandCodeRandomUUID(): string {
	return globalThis.crypto?.randomUUID?.() ?? `thread-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function projectSlugFromPath(pathName: string): string {
	const slug = pathName
		.toLowerCase()
		.replace(/^[a-z]:/i, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "project";
}

function parseStreamEventLine(line: string): unknown | undefined {
	let trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined;
	if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
	if (!trimmed || trimmed === "[DONE]") return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function mapFinishReason(reason: unknown): StopReason {
	if (reason === "tool-calls") return "toolUse";
	if (reason === "length" || reason === "max_tokens" || reason === "max-tokens" || reason === "max_output_tokens") {
		return "length";
	}
	return "stop";
}

function promptPartToText(value: unknown, depth = 0): string {
	if (depth > 10) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value))
		return value
			.map((item) => promptPartToText(item, depth + 1))
			.filter(Boolean)
			.join("\n");
	if (!isRecord(value)) return "";
	const text = stringValue(value.text);
	if (text) return text;
	return promptPartToText(value.content, depth + 1);
}

function systemPromptToText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value))
		return value
			.map((item) => promptPartToText(item))
			.filter(Boolean)
			.join("\n\n");
	return promptPartToText(value);
}

function textContent(message: { content?: unknown }): string {
	return recordArray(message.content)
		.filter((part) => part.type === "text")
		.map((part) => stringValue(part.text) ?? "")
		.join("\n");
}

function toJsonSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return {};
	const kind = stringValue(schema.kind) ?? stringValue(schema.type);
	if (Array.isArray(schema.enum)) return { type: typeof schema.enum[0], enum: schema.enum };
	if (kind === "string" || kind === "String") return { type: "string" };
	if (kind === "number" || kind === "Number") return { type: "number" };
	if (kind === "boolean" || kind === "Boolean") return { type: "boolean" };
	if (kind === "array" || kind === "Array")
		return { type: "array", items: toJsonSchema(schema.items ?? schema.element) };
	if (kind === "object" || kind === "Object") {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		const sourceProperties = isRecord(schema.properties) ? schema.properties : undefined;
		const optional = Array.isArray(schema.optional)
			? schema.optional.filter((item): item is string => typeof item === "string")
			: [];
		for (const [key, value] of Object.entries(sourceProperties ?? {})) {
			properties[key] = toJsonSchema(value);
			if (!(isRecord(value) && value.optional === true) && !optional.includes(key)) required.push(key);
		}
		return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
	}
	return {};
}

function toolsToJson(tools?: readonly Tool[]): unknown[] {
	return (tools ?? []).map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		input_schema: toJsonSchema(tool.parameters),
	}));
}

function completeToolCallIds(messages: readonly Message[]): Set<string> {
	const callIds = new Set<string>();
	const resultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const content of message.content) {
				if (content.type === "toolCall") callIds.add(content.id);
			}
		} else if (message.role === "toolResult") {
			resultIds.add(message.toolCallId);
		}
	}
	return new Set([...callIds].filter((id) => resultIds.has(id)));
}

function messagesToCommandCode(messages: readonly Message[]): unknown[] {
	const out: unknown[] = [];
	const pairedToolCallIds = completeToolCallIds(messages);
	for (const message of messages) {
		if (message.role === "user") {
			out.push({ role: "user", content: message.content });
		} else if (message.role === "assistant") {
			const parts: unknown[] = [];
			for (const content of message.content) {
				if (content.type === "text") parts.push({ type: "text", text: content.text });
				if (content.type === "thinking") parts.push({ type: "reasoning", text: content.thinking });
				if (content.type === "toolCall" && pairedToolCallIds.has(content.id)) {
					parts.push({
						type: "tool-call",
						toolCallId: content.id,
						toolName: content.name,
						input: content.arguments,
					});
				}
			}
			if (parts.length > 0) out.push({ role: "assistant", content: parts });
		} else if (pairedToolCallIds.has(message.toolCallId)) {
			out.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						output: message.isError
							? { type: "error-text", value: textContent(message) }
							: { type: "text", value: textContent(message) },
					},
				],
			});
		}
	}
	return out;
}

function generateMaxTokens(model: Model<"commandcode">, options?: StreamOptions): number {
	return Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens, DEFAULT_GENERATE_MAX_TOKENS);
}

function successStopReason(reason: StopReason): "stop" | "length" | "toolUse" {
	return reason === "length" || reason === "toolUse" ? reason : "stop";
}

function pushError(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	reason: "error" | "aborted",
	message: string,
) {
	output.stopReason = reason;
	output.errorMessage = message;
	stream.push({ type: "error", reason, error: output });
}

export function stream(
	model: Model<"commandcode">,
	context: Context,
	options?: CommandCodeOptions,
): AssistantMessageEventStream {
	const output = emptyAssistant(model);
	const stream = new AssistantMessageEventStream();

	void (async () => {
		if (!options?.apiKey) {
			pushError(
				stream,
				output,
				"error",
				"No Command Code API key. Run /login for Command Code, set COMMANDCODE_API_KEY, or configure ~/.commandcode/auth.json or ~/.pi/agent/auth.json.",
			);
			stream.end();
			return;
		}

		const controller = new AbortController();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let textIndex = -1;
		let thinkingIndex = -1;
		let finished = false;
		const abortUpstream = () => controller.abort();
		options.signal?.addEventListener("abort", abortUpstream, { once: true });

		const endText = () => {
			if (textIndex < 0) return;
			const block = output.content[textIndex];
			if (block?.type === "text")
				stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
			textIndex = -1;
		};
		const endThinking = () => {
			if (thinkingIndex < 0) return;
			const block = output.content[thinkingIndex];
			if (block?.type === "thinking") {
				stream.push({
					type: "thinking_end",
					contentIndex: thinkingIndex,
					content: block.thinking,
					partial: output,
				});
			}
			thinkingIndex = -1;
		};

		const handleEvent = (event: unknown) => {
			if (!isRecord(event)) return;
			switch (event.type) {
				case "text-delta": {
					endThinking();
					if (textIndex < 0) {
						output.content.push({ type: "text", text: "" });
						textIndex = output.content.length - 1;
						stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
					}
					const block = output.content[textIndex];
					const delta = stringValue(event.text) ?? "";
					if (block?.type === "text") block.text += delta;
					stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: output });
					break;
				}
				case "reasoning-start":
					endText();
					break;
				case "reasoning-delta": {
					endText();
					const delta = stringValue(event.text) ?? "";
					if (thinkingIndex < 0) {
						output.content.push({ type: "thinking", thinking: delta });
						thinkingIndex = output.content.length - 1;
						stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
					} else {
						const block = output.content[thinkingIndex];
						if (block?.type === "thinking") block.thinking += delta;
					}
					stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: output });
					break;
				}
				case "reasoning-end":
					endThinking();
					break;
				case "tool-result":
					break;
				case "tool-call": {
					endText();
					endThinking();
					const toolCall: ToolCall = {
						type: "toolCall",
						id: stringValue(event.toolCallId) ?? "",
						name: stringValue(event.toolName) ?? "",
						arguments: recordOrEmpty(event.input ?? event.args ?? event.arguments),
					};
					output.content.push(toolCall);
					const contentIndex = output.content.length - 1;
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
					break;
				}
				case "finish": {
					const usage = isRecord(event.totalUsage) ? event.totalUsage : undefined;
					const details = isRecord(usage?.inputTokenDetails) ? usage.inputTokenDetails : undefined;
					output.usage.input = numberValue(usage?.inputTokens) ?? 0;
					output.usage.output = numberValue(usage?.outputTokens) ?? 0;
					output.usage.cacheRead = numberValue(details?.cacheReadTokens) ?? 0;
					output.usage.cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0;
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
					output.stopReason = mapFinishReason(event.finishReason);
					finished = true;
					break;
				}
				case "error": {
					const errorRecord = isRecord(event.error) ? event.error : undefined;
					throw new Error(stringValue(errorRecord?.message) ?? stringValue(event.error) ?? "Stream error");
				}
			}
		};

		try {
			stream.push({ type: "start", partial: output });
			const workingDir = process.cwd();
			let body: unknown = {
				config: {
					workingDir,
					date: new Date().toISOString().split("T")[0],
					environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
					structure: [],
					isGitRepo: false,
					currentBranch: "",
					mainBranch: "",
					gitStatus: "",
					recentCommits: [],
				},
				memory: null,
				taste: null,
				skills: null,
				params: {
					model: model.id,
					messages: messagesToCommandCode(context.messages),
					tools: toolsToJson(context.tools),
					system: systemPromptToText(context.systemPrompt),
					max_tokens: generateMaxTokens(model, options),
					temperature: options.temperature ?? 0.3,
					stream: true,
				},
				threadId: commandCodeRandomUUID(),
			};
			body = (await options.onPayload?.(body, model)) ?? body;

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${options.apiKey}`,
				"x-command-code-version": COMMAND_CODE_CLI_VERSION,
				"x-cli-environment": "production",
				"x-project-slug": projectSlugFromPath(workingDir),
				"x-taste-learning": "true",
				"x-co-flag": "false",
			};
			for (const [key, value] of Object.entries(options.headers ?? {})) {
				if (value === null) delete headers[key];
				else headers[key] = value;
			}

			const maxRetries = options.maxRetries ?? 0;
			const maxRetryDelayMs =
				options.maxRetryDelayMs === 0
					? Number.POSITIVE_INFINITY
					: (options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS);
			const bodyString = JSON.stringify(body);
			const apiBase = options.env?.COMMANDCODE_API_BASE ?? model.baseUrl ?? COMMANDCODE_BASE_URL;

			for (let attempt = 0; ; attempt++) {
				const attemptController = new AbortController();
				let attemptTimedOut = false;
				let timeoutId: ReturnType<typeof setTimeout> | undefined;
				const onAbort = () => attemptController.abort();
				controller.signal.addEventListener("abort", onAbort, { once: true });
				if (options.timeoutMs !== undefined) {
					timeoutId = setTimeout(() => {
						attemptTimedOut = true;
						attemptController.abort();
					}, options.timeoutMs);
				}

				try {
					let response: Response;
					try {
						response = await fetch(`${apiBase}/alpha/generate`, {
							method: "POST",
							headers,
							body: bodyString,
							signal: attemptController.signal,
						});
					} catch (error) {
						if (controller.signal.aborted) throw abortError("Aborted");
						if (attemptTimedOut && attempt < maxRetries) continue;
						if (attemptTimedOut) throw timeoutError(options.timeoutMs);
						throw error;
					}

					if (!response.ok && isRetryableStatus(response.status) && attempt < maxRetries) {
						const waitMs = retryDelayMs(attempt, response.headers.get("retry-after"), maxRetryDelayMs);
						await response.text().catch(() => "");
						if (waitMs < 0) throw new Error("Retry-After delay exceeds max retry delay");
						if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
						continue;
					}

					const responseInfo: ProviderResponse = {
						status: response.status,
						headers: headersToRecord(response.headers),
					};
					await options.onResponse?.(responseInfo, model);
					if (!response.ok)
						throw new Error(
							`Command Code API error ${response.status}: ${(await response.text()).slice(0, 500)}`,
						);

					reader = response.body?.getReader();
					if (!reader) throw new Error("No response body");
					const decoder = new TextDecoder();
					let buffer = "";
					for (;;) {
						if (controller.signal.aborted) throw abortError("Aborted");
						const { done, value } = await reader.read();
						if (done) {
							if (buffer.trim()) handleEvent(parseStreamEventLine(buffer));
							break;
						}
						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";
						for (const line of lines) {
							handleEvent(parseStreamEventLine(line));
							if (finished) break;
						}
						if (finished) break;
					}

					endText();
					endThinking();
					stream.push({ type: "done", reason: successStopReason(output.stopReason), message: output });
					stream.end();
					break;
				} finally {
					controller.signal.removeEventListener("abort", onAbort);
					if (timeoutId !== undefined) clearTimeout(timeoutId);
				}
			}
		} catch (error) {
			const reason = controller.signal.aborted ? "aborted" : "error";
			pushError(
				stream,
				output,
				reason,
				reason === "aborted" ? "Request aborted" : error instanceof Error ? error.message : String(error),
			);
			stream.end();
		} finally {
			options.signal?.removeEventListener("abort", abortUpstream);
			await reader?.cancel().catch(() => undefined);
		}
	})();

	return stream;
}

export function streamSimple(
	model: Model<"commandcode">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return stream(model, context, options);
}

export const __test = { messagesToCommandCode, parseStreamEventLine, projectSlugFromPath, toolsToJson };
