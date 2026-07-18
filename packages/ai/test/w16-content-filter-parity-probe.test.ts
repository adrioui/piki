import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

/**
 * Parity probe (W16 Scientist): mag maps a `content_filter` finish reason to a
 * distinct graceful terminal outcome `ContentFiltered` (mapFinishReasonToOutcome,
 * embedded.js:76658), NOT to a generic "stop". piki's provider-specific decoders
 * currently collapse content_filter -> "stop" (the genuine D6 GAP). This probe
 * asserts the mag-correct target behavior. It PASSES only after D6a/b/c are
 * applied (anthropic-messages.ts:1313, bedrock-converse-stream.ts:953,
 * openai-completions.ts:1178 each map content_filter -> "contentFiltered").
 */

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

// ---- Anthropic fixture ----
function sse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function fakeAnthropic(response: Response): Anthropic {
	return { messages: { create: () => ({ asResponse: async () => response }) } } as unknown as Anthropic;
}
function anthropicContentFilterStream(): Response {
	return sse([
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_t",
					usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "content_filter" },
				usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	]);
}

// ---- Bedrock fixture ----
const bedrockMock = vi.hoisted(() => ({
	sentCommands: [] as Array<{ input: unknown }>,
	streamItems: [] as Record<string, unknown>[],
}));
vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeClient {
		middlewareStack = { add: () => undefined };
		send(command: { input: unknown }): Promise<{ stream: AsyncIterable<Record<string, unknown>> }> {
			bedrockMock.sentCommands.push({ input: command.input });
			return Promise.resolve({
				$metadata: {},
				stream: {
					async *[Symbol.asyncIterator]() {
						for (const item of bedrockMock.streamItems) yield item;
					},
				},
			});
		}
	}
	class ConverseStreamCommand {
		readonly input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}
	return {
		BedrockRuntimeClient,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
			CONTENT_FILTERED: "content_filtered",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

// Note: openai-completions, mistral, google, commandcode, codex decoders have no
// injectable fetch mock in the piki test harness and cannot be cleanly probed
// here. Their content_filter handling (openai-completions.ts:1178 collapses to
// "stop") is verified by source read in the W16 report.

describe("W16 content_filter -> contentFiltered parity (mag oracle)", () => {
	afterEach(() => {
		bedrockMock.sentCommands.length = 0;
		bedrockMock.streamItems.length = 0;
	});

	it("anthropic content_filter -> contentFiltered", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const result = await streamAnthropic(model, context, {
			client: fakeAnthropic(anthropicContentFilterStream()),
		}).result();
		expect(result.stopReason).toBe("contentFiltered");
	});

	it("bedrock content_filtered -> contentFiltered", async () => {
		bedrockMock.streamItems = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockStart: { contentBlockIndex: 0, start: { text: "" } } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } },
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "content_filtered" } },
		];
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8") as Model<"bedrock-converse-stream">;
		const result = await streamBedrock(model, context, { cacheRetention: "none" }).result();
		expect(result.stopReason).toBe("contentFiltered");
	});
});
