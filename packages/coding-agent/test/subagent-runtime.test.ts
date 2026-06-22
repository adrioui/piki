/**
 * Tests for the subagent runtime (runSubagent).
 */

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { runSubagent, type SubagentTool } from "../src/core/subagent/runtime.ts";

describe("subagent runtime", () => {
	const registrations: Array<() => void> = [];

	afterEach(() => {
		for (const unregister of registrations) {
			unregister();
		}
		registrations.length = 0;
	});

	it("returns final text when model emits no tool calls", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());

		faux.setResponses([fauxAssistantMessage("Hello, I am the subagent. Here is what I found.")]);

		const model = faux.getModel();

		const result = await runSubagent({
			model,
			systemPrompt: "You are a test subagent.",
			userMessage: "find the answer",
			allowedTools: [],
			tools: [],
			maxTurns: 5,
		});

		expect(result.text).toBe("Hello, I am the subagent. Here is what I found.");
		expect(result.turns).toBe(1);
		expect(result.error).toBeUndefined();
	});

	it("executes tools and returns final text after tool call turn", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());

		const executedTools: string[] = [];
		const echoTool: SubagentTool = {
			name: "echo",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, args) => {
				const a = args as Record<string, unknown>;
				executedTools.push(a.text as string);
				return `echo:${a.text}`;
			},
		};

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Result: I found the data."),
		]);

		const model = faux.getModel();

		const result = await runSubagent({
			model,
			systemPrompt: "You are a test subagent.",
			userMessage: "find data",
			allowedTools: ["echo"],
			tools: [echoTool],
			maxTurns: 5,
		});

		expect(executedTools).toEqual(["hello"]);
		expect(result.text).toBe("Result: I found the data.");
		expect(result.turns).toBe(2);
	});

	it("respects maxTurns and returns error when exceeded", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());

		const toolRuns: number[] = [];
		const loopTool: SubagentTool = {
			name: "looper",
			parameters: Type.Object({}),
			execute: async () => {
				toolRuns.push(toolRuns.length);
				return "still going...";
			},
		};

		// Each turn the subagent calls the tool, gets a result, and calls again
		const responses: Array<ReturnType<typeof fauxAssistantMessage>> = [];
		for (let i = 0; i < 3; i++) {
			responses.push(fauxAssistantMessage(fauxToolCall("looper", {}), { stopReason: "toolUse" }));
		}
		faux.setResponses(responses);
		const model = faux.getModel();

		const result = await runSubagent({
			model,
			systemPrompt: "You are a test subagent.",
			userMessage: "loop",
			allowedTools: ["looper"],
			tools: [loopTool],
			maxTurns: 2,
		});

		expect(result.text).toBe("");
		expect(result.error).toContain("exceeded max turns");
		expect(result.turns).toBe(2);
	});

	it("stops after same error threshold", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());

		const brokenTool: SubagentTool = {
			name: "broken",
			parameters: Type.Object({}),
			execute: async () => {
				throw new Error("Disk full");
			},
		};

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("broken", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("broken", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("broken", {}), { stopReason: "toolUse" }),
		]);

		const model = faux.getModel();

		const result = await runSubagent({
			model,
			systemPrompt: "You are a test subagent.",
			userMessage: "run",
			allowedTools: ["broken"],
			tools: [brokenTool],
			maxTurns: 10,
			sameErrorThreshold: 2,
		});

		expect(result.error).toContain("same-error threshold");
	});

	it("rejects tools not in allowedTools", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());

		let forbiddenExecuted = false;
		const forbiddenTool: SubagentTool = {
			name: "forbidden",
			parameters: Type.Object({}),
			execute: async () => {
				forbiddenExecuted = true;
				return "secret data";
			},
		};

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("forbidden", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("I cannot access that tool."),
		]);

		const model = faux.getModel();

		const result = await runSubagent({
			model,
			systemPrompt: "You are a test subagent.",
			userMessage: "use forbidden tool",
			allowedTools: [], // forbidden is not in allowed list
			tools: [forbiddenTool],
			maxTurns: 5,
		});

		expect(forbiddenExecuted).toBe(false);
		expect(result.text).toBe("I cannot access that tool.");
	});
});
