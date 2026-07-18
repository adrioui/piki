/**
 * W24 Scientist — native decoder replay parity vs mag alpha22 embedded codec.
 *
 * Reinforces packages/coding-agent/test/suite/parity/provider-decoder-replay.test.ts
 * (which only asserted `StreamingFieldParser` is exported) by actually replaying
 * chunk sequences through the public native `decode` and asserting the normalized
 * event ordering + terminal outcomes match mag's `decode7` / `buildTerminal` /
 * `mapFinishReasonToOutcome` (embedded.js:75622-76667).
 *
 * No source modified. Focused, deterministic, no network.
 */

import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { decode } from "../src/codec/native-chat-completions/decode.ts";
import type { ChatCompletionsStreamChunk } from "../src/wire/chat-completions.ts";

async function run(chunks: ChatCompletionsStreamChunk[], tools?: Array<{ name: string; inputSchema: unknown }>) {
	const { events } = decode(Stream.fromIterable(chunks), {
		streamContext: {
			responseHeaders: new Headers(),
			call: { method: "POST", url: "https://x/chat/completions", provider: "magnitude", model: "x" },
			response: { status: 200, headers: [], requestId: null, traceId: null },
		},
		tools,
		generateToolCallId: () => "call_generated",
		toStreamFailure: (e) => e as never,
	});
	const collected = await Effect.runPromise(Stream.runCollect(events));
	return Array.from(collected);
}

function textChunk(text: string, finish?: string): ChatCompletionsStreamChunk {
	const c: ChatCompletionsStreamChunk = {
		id: "chunk",
		object: "chat.completion.chunk",
		created: 0,
		model: "x",
		choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
	};
	if (finish !== undefined) (c.choices[0] as { finish_reason?: string }).finish_reason = finish;
	return c;
}

describe("native decoder replay vs mag", () => {
	it("orders events text -> stream_end(completed) for a simple stop", async () => {
		const events = await run([textChunk("hello"), textChunk("", "stop")]);
		const tags = events.map((e) => e._tag);
		expect(tags).toEqual(["message_start", "message_delta", "message_end", "stream_end"]);
		const end = events[events.length - 1] as { terminal: { _tag: string } };
		expect(end.terminal._tag).toBe("StreamCompleted");
	});

	it("accumulates a tool call with field events then tool_call_ready", async () => {
		const chunk1: ChatCompletionsStreamChunk = {
			id: "chunk",
			object: "chat.completion.chunk",
			created: 0,
			model: "x",
			choices: [
				{
					index: 0,
					delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "run", arguments: "" } }] },
					finish_reason: null,
				},
			],
		};
		const chunk2: ChatCompletionsStreamChunk = {
			id: "chunk",
			object: "chat.completion.chunk",
			created: 0,
			model: "x",
			choices: [
				{
					index: 0,
					delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] },
					finish_reason: null,
				},
			],
		};
		const chunk3: ChatCompletionsStreamChunk = {
			id: "chunk",
			object: "chat.completion.chunk",
			created: 0,
			model: "x",
			choices: [
				{
					index: 0,
					delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] },
					finish_reason: "tool_calls",
				},
			],
		};
		const events = await run([chunk1, chunk2, chunk3]);
		const tags = events.map((e) => e._tag);
		expect(tags).toContain("tool_call_start");
		expect(tags).toContain("tool_call_field_start");
		expect(tags).toContain("tool_call_field_delta");
		expect(tags).toContain("tool_call_field_end");
		expect(tags).toContain("tool_call_ready");
		// tool_call_ready must precede stream_end
		expect(tags.indexOf("tool_call_ready")).toBeLessThan(tags.indexOf("stream_end"));
		const end = events[events.length - 1] as { terminal: { _tag: string } };
		expect(end.terminal._tag).toBe("StreamCompleted");
	});

	it("content_filter -> StreamCompleted(finishReason=content_filter), matches mag ContentFiltered", async () => {
		const events = await run([textChunk("partial"), textChunk("", "content_filter")]);
		const end = events[events.length - 1] as { terminal: { _tag: string; finishReason?: string } };
		// mag mapFinishReasonToOutcome: content_filter -> ContentFiltered (a graceful
		// terminal, NOT a StreamFailed correctness violation). piki emits StreamCompleted
		// with finishReason="content_filter", which the dispatcher maps to ContentFiltered.
		expect(end.terminal._tag).toBe("StreamCompleted");
		expect(end.terminal.finishReason).toBe("content_filter");
	});

	it("finishing-phase usage (S-US): usage arrives after finish_reason, still StreamCompleted", async () => {
		// mag decode7: when finish_reason sets phase=finishing (no usage in that
		// chunk), a subsequent chunk carrying only usage emits stream_end with
		// StreamCompleted + usage. piki must accept it identically.
		const finishChunk: ChatCompletionsStreamChunk = {
			id: "chunk",
			object: "chat.completion.chunk",
			created: 0,
			model: "x",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		};
		const usageChunk: ChatCompletionsStreamChunk = {
			id: "chunk",
			object: "chat.completion.chunk",
			created: 0,
			model: "x",
			choices: [{ index: 0, delta: {}, finish_reason: null }],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		};
		const events = await run([finishChunk, usageChunk]);
		const end = events[events.length - 1] as { terminal: { _tag: string } };
		expect(end.terminal._tag).toBe("StreamCompleted");
		const completed = end.terminal as unknown as { usage: { _tag: string } };
		expect(completed.usage._tag).toBe("UsageReported");
	});

	it("malformed tool args (S-LV): schema-strict -> validation_failure -> StreamFailed", async () => {
		const schema = Schema.Struct({ cmd: Schema.String });
		const start: ChatCompletionsStreamChunk = {
			id: "chunk",
			object: "chat.completion.chunk",
			created: 0,
			model: "x",
			choices: [
				{
					index: 0,
					delta: { tool_calls: [{ index: 0, id: "call_bad", function: { name: "run", arguments: "not json" } }] },
					finish_reason: "tool_calls",
				},
			],
		};
		const events = await run([start], [{ name: "run", inputSchema: schema }]);
		const end = events[events.length - 1] as { terminal: { _tag: string } };
		expect(end.terminal._tag).toBe("StreamFailed");
	});

	it("unknown finish_reason -> StreamCompleted (graceful), matches mag default case", async () => {
		const events = await run([textChunk("x"), textChunk("", "some_unknown_reason")]);
		const end = events[events.length - 1] as { terminal: { _tag: string } };
		expect(end.terminal._tag).toBe("StreamCompleted");
	});
});
