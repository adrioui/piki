import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: { create: () => ({ asResponse: async () => response }) },
	} as unknown as Anthropic;
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function minimalMessageStart(id: string) {
	return {
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id,
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	};
}

function messageStop(stopReason: string) {
	return {
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: stopReason },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	};
}

describe("anthropic content_filter stop reason parity", () => {
	it("maps content_filter to a graceful contentFiltered (mag ContentFiltered outcome)", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const response = createSseResponse([
			minimalMessageStart("msg_test"),
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "partial" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			messageStop("content_filter"),
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		}).result();

		expect(result.stopReason).toBe("contentFiltered");
		expect(result.errorMessage).toBeUndefined();
	});

	it("maps an unknown stop reason to a graceful stop (non-error)", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const response = createSseResponse([
			minimalMessageStart("msg_unk"),
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			messageStop("some_future_reason"),
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		// Unknown stop reasons are mapped to a graceful "stop" (not an error),
		// matching mag's behavior of completing the turn as a terminal outcome
		// for reasons it does not recognize.
		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});
});
