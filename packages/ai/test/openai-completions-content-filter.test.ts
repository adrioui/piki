import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunkSets: [] as unknown[][],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (_payload: unknown) => {
					const chunks = mockState.chunkSets.shift() ?? [];
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
					const result = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					result.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return result;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const readTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
};

function model(): Model<"openai-completions"> {
	return {
		id: "google/gemini-test",
		name: "Gemini Test",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
	return {
		id: "chatcmpl-test",
		model: "google/gemini-test",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function runStream(messages: AssistantMessage[] = []): Promise<AssistantMessage> {
	return streamOpenAICompletions(model(), { messages, tools: [readTool] }, { apiKey: "test" }).result();
}

describe("openai-completions content_filter stop reason parity", () => {
	it("maps content_filter to a graceful contentFiltered (mag ContentFiltered outcome)", async () => {
		mockState.chunkSets = [[chunk({ content: "partial" }, "content_filter")]];

		const result = await runStream();

		expect(result.stopReason).toBe("contentFiltered");
		expect(result.errorMessage).toBeUndefined();
	});

	it("preserves error semantics for network_error", async () => {
		mockState.chunkSets = [[chunk({ content: "x" }, "network_error")]];

		const result = await runStream();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("network_error");
	});

	it("maps an unknown finish reason to a graceful stop (non-error)", async () => {
		mockState.chunkSets = [[chunk({ content: "x" }, "some_future_reason")]];

		const result = await runStream();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});
});
