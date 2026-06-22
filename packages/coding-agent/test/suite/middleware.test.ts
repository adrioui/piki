/**
 * Tests for tool call middleware: ToolCallMiddlewareResult and ToolResultMiddlewareResult
 * handling in ExtensionRunner.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallMiddlewareResult, ToolResultMiddlewareResult } from "../../src/core/extensions/index.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("Tool call middleware", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("modify action changes tool call arguments", async () => {
		const toolRuns: unknown[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				toolRuns.push(params);
				return {
					content: [{ type: "text", text: `echo:${(params as Record<string, unknown>).text}` }],
					details: { params },
				};
			},
		};

		const middlewareExtension: ExtensionFactory = (pi) => {
			pi.on("tool_call", (_event) => {
				// Return middleware-style modify result
				return {
					action: "modify",
					args: { text: "modified" },
				} satisfies ToolCallMiddlewareResult;
			});
		};

		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [middlewareExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "original" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		expect(toolRuns.length).toBe(1);
		expect(toolRuns[0]).toEqual({ text: "modified" });
	});

	it("reject action blocks tool execution with reason", async () => {
		let toolExecuted = false;
		const secretTool: AgentTool = {
			name: "secret",
			label: "Secret",
			description: "A secret tool",
			parameters: Type.Object({ data: Type.String() }),
			execute: async () => {
				toolExecuted = true;
				return { content: [{ type: "text", text: "executed" }], details: {} };
			},
		};

		const middlewareExtension: ExtensionFactory = (pi) => {
			pi.on("tool_call", (_event) => {
				return {
					action: "reject",
					reason: "This tool is not allowed",
				} satisfies ToolCallMiddlewareResult;
			});
		};

		const harness = await createHarness({
			tools: [secretTool],
			extensionFactories: [middlewareExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("secret", { data: "test" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		expect(toolExecuted).toBe(false);

		// The tool result should contain the rejection reason
		const toolResultMsg = harness.session.messages.find((m) => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		expect(getMessageText(toolResultMsg)).toContain("This tool is not allowed");
		expect(
			toolResultMsg && "isError" in toolResultMsg ? (toolResultMsg as { isError?: boolean }).isError : undefined,
		).toBe(true);
	});

	it("synthesize action returns immediate result without executing tool", async () => {
		let toolExecuted = false;
		const someTool: AgentTool = {
			name: "some_tool",
			label: "Some Tool",
			description: "A tool",
			parameters: Type.Object({ input: Type.String() }),
			execute: async () => {
				toolExecuted = true;
				return { content: [{ type: "text", text: "real result" }], details: {} };
			},
		};

		const middlewareExtension: ExtensionFactory = (pi) => {
			pi.on("tool_call", (_event) => {
				return {
					action: "synthesize",
					result: {
						content: [{ type: "text", text: "synthetic result" }],
						details: { synthetic: true },
					},
				} satisfies ToolCallMiddlewareResult;
			});
		};

		const harness = await createHarness({
			tools: [someTool],
			extensionFactories: [middlewareExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("some_tool", { input: "test" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		expect(toolExecuted).toBe(false);

		// Verify the synthetic result was used
		const toolResultMsg = harness.session.messages.find((m) => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		expect(getMessageText(toolResultMsg)).toContain("synthetic result");
	});

	it("tool_result modify action changes content", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				return {
					content: [{ type: "text", text: `echo:${(params as Record<string, unknown>).text}` }],
					details: { params },
				};
			},
		};

		const resultMiddleware: ExtensionFactory = (pi) => {
			pi.on("tool_result", (_event) => {
				return {
					action: "modify",
					content: [{ type: "text", text: "modified result" }],
				} satisfies ToolResultMiddlewareResult;
			});
		};

		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [resultMiddleware],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolResultMsg = harness.session.messages.find((m) => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		expect(getMessageText(toolResultMsg)).toContain("modified result");
		expect(getMessageText(toolResultMsg)).not.toContain("echo:hello");
	});

	it("tool_result reject action replaces result with error", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				return {
					content: [{ type: "text", text: `echo:${(params as Record<string, unknown>).text}` }],
					details: { params },
				};
			},
		};

		const resultMiddleware: ExtensionFactory = (pi) => {
			pi.on("tool_result", (_event) => {
				return {
					action: "reject",
					reason: "Result was rejected by security policy",
				} satisfies ToolResultMiddlewareResult;
			});
		};

		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [resultMiddleware],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolResultMsg = harness.session.messages.find((m) => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		expect(getMessageText(toolResultMsg)).toContain("rejected by security policy");
		expect(
			toolResultMsg && "isError" in toolResultMsg ? (toolResultMsg as { isError?: boolean }).isError : undefined,
		).toBe(true);
	});

	it("allow action lets tool execute normally", async () => {
		const toolRuns: unknown[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				toolRuns.push(params);
				return {
					content: [{ type: "text", text: `echo:${(params as Record<string, unknown>).text}` }],
					details: { params },
				};
			},
		};

		const middlewareExtension: ExtensionFactory = (pi) => {
			pi.on("tool_call", (_event) => {
				return {
					action: "allow",
				} satisfies ToolCallMiddlewareResult;
			});
		};

		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [middlewareExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		expect(toolRuns.length).toBe(1);
		expect(toolRuns[0]).toEqual({ text: "hello" });
	});
});
