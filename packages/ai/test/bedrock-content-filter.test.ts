import { afterEach, describe, expect, it, vi } from "vitest";

type StreamItem = Record<string, unknown>;

const bedrockMock = vi.hoisted(() => ({
	sentCommands: [] as Array<{ input: unknown }>,
	streamItems: [] as StreamItem[],
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		middlewareStack = {
			add: () => undefined,
		};

		send(command: { input: unknown }): Promise<{ stream: AsyncIterable<StreamItem> }> {
			bedrockMock.sentCommands.push({ input: command.input });
			return Promise.resolve({
				$metadata: {},
				stream: {
					async *[Symbol.asyncIterator]() {
						for (const item of bedrockMock.streamItems) {
							yield item;
						}
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
		BedrockRuntimeServiceException,
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

import type { BedrockOptions } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function getModelFixture(): Model<"bedrock-converse-stream"> {
	return getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
}

function textStreamItems(stopReason: string): StreamItem[] {
	return [
		{ messageStart: { role: "assistant" } },
		{ contentBlockStart: { contentBlockIndex: 0, start: { text: "" } } },
		{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } },
		{ contentBlockStop: { contentBlockIndex: 0 } },
		{ messageStop: { stopReason } },
	];
}

async function runStream(options: BedrockOptions): Promise<string> {
	const result = await streamBedrock(getModelFixture(), context, options).result();
	return result.stopReason;
}

describe("bedrock content_filter stop reason parity", () => {
	afterEach(() => {
		bedrockMock.sentCommands.length = 0;
		bedrockMock.streamItems.length = 0;
	});

	it("maps content_filtered to contentFiltered (mag ContentFiltered outcome)", async () => {
		bedrockMock.streamItems = textStreamItems("content_filtered");

		const stopReason = await runStream({ cacheRetention: "none" });

		expect(stopReason).toBe("contentFiltered");
	});

	it("still maps end_turn to stop", async () => {
		bedrockMock.streamItems = textStreamItems("end_turn");

		const stopReason = await runStream({ cacheRetention: "none" });

		expect(stopReason).toBe("stop");
	});

	it("maps an unknown stop reason to a graceful stop (non-error)", async () => {
		bedrockMock.streamItems = textStreamItems("some_future_reason");

		const stopReason = await runStream({ cacheRetention: "none" });

		expect(stopReason).toBe("stop");
	});
});
