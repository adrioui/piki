import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";

function toolNames(tools: Array<{ name: string }>): string[] {
	return tools.map((tool) => tool.name).sort();
}

describe("regression #5109: exclude tools", () => {
	const extensionFactories: ExtensionFactory[] = [
		(piki) => {
			piki.on("session_start", () => {
				piki.registerTool({
					name: "ask_question",
					label: "Ask Question",
					description: "Ask a question",
					promptSnippet: "Ask a question",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				});
				piki.registerTool({
					name: "dynamic_tool",
					label: "Dynamic Tool",
					description: "Dynamic test tool",
					promptSnippet: "Run dynamic test behavior",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				});
			});
		},
	];

	it("filters built-in and extension tools from available and active tools", async () => {
		const harness = await createHarness({
			excludedToolNames: ["read", "ask_question"],
			extensionFactories,
		});
		try {
			await harness.session.bindExtensions({});

			const allToolNames = toolNames(harness.session.getAllTools());
			expect(allToolNames).not.toContain("read");
			expect(allToolNames).not.toContain("ask_question");
			expect(allToolNames).toContain("bash");
			expect(allToolNames).toContain("dynamic_tool");
			// Core tools now include role-control, scratchpad, and web tools
			const activeTools = harness.session.getActiveToolNames().sort();
			expect(activeTools).toContain("bash");
			expect(activeTools).toContain("dynamic_tool");
			expect(activeTools).toContain("edit");
			expect(activeTools).toContain("write");
			expect(activeTools).toContain("scratchpad_save");
			expect(activeTools).toContain("scratchpad_load");
			expect(activeTools).toContain("web_search");
			expect(activeTools).toContain("web_fetch");
			expect(activeTools).toContain("create_task");
			expect(activeTools).toContain("finish_goal");
			expect(activeTools).not.toContain("read");
			expect(activeTools).not.toContain("ask_question");
			expect(harness.session.systemPrompt).not.toContain("- read:");
			expect(harness.session.systemPrompt).not.toContain("ask_question");
			expect(harness.session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		} finally {
			harness.cleanup();
		}
	});

	it("lets excluded tools override the allowlist", async () => {
		const harness = await createHarness({
			allowedToolNames: ["read", "bash", "ask_question"],
			excludedToolNames: ["read", "ask_question"],
			initialActiveToolNames: ["read", "bash", "ask_question"],
			extensionFactories,
		});
		try {
			await harness.session.bindExtensions({});

			expect(toolNames(harness.session.getAllTools())).toEqual(["bash"]);
			expect(harness.session.getActiveToolNames()).toEqual(["bash"]);
			expect(harness.session.systemPrompt).toContain("- bash:");
			expect(harness.session.systemPrompt).not.toContain("- read:");
			expect(harness.session.systemPrompt).not.toContain("ask_question");
		} finally {
			harness.cleanup();
		}
	});
});
