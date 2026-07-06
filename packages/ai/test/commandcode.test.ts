import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __test, stream } from "../src/api/commandcode.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { commandCodeProvider } from "../src/providers/commandcode.ts";
import { commandCodeModelsFromApiResponse } from "../src/providers/commandcode-catalog.ts";
import type { Context, Model, Tool } from "../src/types.ts";

const model: Model<"commandcode"> = {
	id: "claude-sonnet-5",
	name: "Claude Sonnet 5",
	api: "commandcode",
	provider: "commandcode",
	baseUrl: "https://api.commandcode.ai",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

describe("Command Code provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("parses provider model responses", () => {
		const models = commandCodeModelsFromApiResponse({
			object: "list",
			data: [{ id: "gpt-5.5", name: "GPT-5.5", context_length: 200_000 }],
		});

		expect(models).toEqual([
			expect.objectContaining({
				id: "gpt-5.5",
				name: "GPT-5.5 (Command Code)",
				api: "commandcode",
				provider: "commandcode",
				maxTokens: 65_536,
			}),
		]);
	});

	it("resolves auth from COMMANDCODE_API_KEY", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "COMMANDCODE_API_KEY" ? "user_test" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(commandCodeProvider());

		const auth = await models.getAuth(model);

		expect(auth).toEqual({ auth: { apiKey: "user_test", baseUrl: undefined }, source: "COMMANDCODE_API_KEY" });
	});

	it("resolves subscription credentials as request auth", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("commandcode", async () => ({
			type: "oauth",
			access: "user_sub",
			refresh: "user_sub",
			expires: Date.now() + 60_000,
		}));
		const models = createModels({ credentials });
		models.setProvider(commandCodeProvider());

		const auth = await models.getAuth(model);

		expect(auth).toEqual({ auth: { apiKey: "user_sub", baseUrl: undefined }, source: "OAuth" });
	});

	it("serializes messages and tool schemas for the Command Code API", () => {
		const tool: Tool = {
			name: "lookup",
			description: "Lookup a value",
			parameters: Type.Object({ query: Type.String() }),
		};
		const context: Context = {
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{
					role: "assistant",
					api: "commandcode",
					provider: "commandcode",
					model: "claude-sonnet-5",
					content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "x" } }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "lookup",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: 3,
				},
			],
			tools: [tool],
		};

		expect(__test.messagesToCommandCode(context.messages)).toEqual([
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { query: "x" } }],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "lookup",
						output: { type: "text", value: "result" },
					},
				],
			},
		]);
		expect(__test.toolsToJson(context.tools)).toEqual([
			{
				type: "function",
				name: "lookup",
				description: "Lookup a value",
				input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
			},
		]);
	});

	it("streams Command Code SSE events", async () => {
		const body = [
			'data: {"type":"reasoning-delta","text":"think"}\n',
			'data: {"type":"reasoning-end"}\n',
			'data: {"type":"text-delta","text":"hello"}\n',
			'data: {"type":"tool-call","toolCallId":"call_1","toolName":"lookup","input":{"query":"x"}}\n',
			'data: {"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":10,"outputTokens":5,"inputTokenDetails":{"cacheReadTokens":2,"cacheWriteTokens":1}}}\n',
		].join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(body));
								controller.close();
							},
						}),
					),
			),
		);

		const events = [];
		for await (const event of stream(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ apiKey: "user_test" },
		)) {
			events.push(event);
		}
		const done = events.at(-1);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_end",
			"done",
		]);
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.reason).toBe("toolUse");
			expect(done.message.usage).toMatchObject({
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 1,
				totalTokens: 18,
			});
			expect(done.message.usage.cost.total).toBeCloseTo(0.0000217);
		}
	});
});
