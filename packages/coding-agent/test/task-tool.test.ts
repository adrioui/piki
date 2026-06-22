/**
 * Tests for the task tool.
 */

import { fauxAssistantMessage, fauxToolCall, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentTool } from "../src/core/subagent/runtime.ts";
import { createTaskToolDefinition, DEFAULT_TASK_TOOLS } from "../src/core/tools/task.ts";

describe("task tool", () => {
	const registrations: Array<() => void> = [];

	afterEach(() => {
		for (const unregister of registrations) {
			unregister();
		}
		registrations.length = 0;
	});

	function makeTool(name: string, log: string[]): SubagentTool {
		return {
			name,
			parameters: Type.Object({}),
			execute: async () => {
				log.push(name);
				return `${name}-result`;
			},
		};
	}

	const baseOptions = (model: Model<string>) => ({
		cwd: process.cwd(),
		model,
		tools: [
			makeTool("read", []),
			makeTool("grep", []),
			makeTool("find", []),
			makeTool("ls", []),
			makeTool("bash", []),
			makeTool("edit", []),
			makeTool("write", []),
		],
		delegatableToolNames: ["read", "grep", "find", "ls", "bash", "edit", "write"],
	});

	it("returns only the final summary", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done: refactored helper and all tests pass."),
		]);

		const result = await createTaskToolDefinition(baseOptions(faux.getModel())).execute(
			"id1",
			{ request: "refactor the helper" },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "Done: refactored helper and all tests pass." });
	});

	it("restricts tools to the requested allowlist (edit/write excluded)", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());
		const editLog: string[] = [];
		const readLog: string[] = [];

		const result = await createTaskToolDefinition({
			cwd: process.cwd(),
			model: faux.getModel(),
			tools: [
				{
					name: "read",
					parameters: Type.Object({}),
					execute: async () => {
						readLog.push("read");
						return "r";
					},
				},
				{
					name: "edit",
					parameters: Type.Object({}),
					execute: async () => {
						editLog.push("edit");
						return "e";
					},
				},
			],
			delegatableToolNames: ["read", "edit"],
		}).execute("id1", { request: "investigate only", allowedTools: ["read"] }, undefined, undefined, {} as never);

		// Faux has no responses queued; the subagent returns empty text with an error.
		// We only assert that edit was never exposed: the details reflect the effective
		// allowed tools and edit is not among them.
		expect(editLog).toEqual([]);
		expect(result.details).toMatchObject({ allowedTools: ["read"] });
		expect(readLog).toEqual([]);
	});

	it("makes edit/write unavailable when not in delegatableToolNames even if requested", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());
		const editLog: string[] = [];

		const result = await createTaskToolDefinition({
			cwd: process.cwd(),
			model: faux.getModel(),
			tools: [
				{ name: "read", parameters: Type.Object({}), execute: async () => "r" },
				{
					name: "edit",
					parameters: Type.Object({}),
					execute: async () => {
						editLog.push("edit");
						return "e";
					},
				},
			],
			delegatableToolNames: ["read"], // edit NOT delegatable
		}).execute("id1", { request: "try edit", allowedTools: ["read", "edit"] }, undefined, undefined, {} as never);

		expect(editLog).toEqual([]);
		// edit dropped because it is not delegatable; only read remains effective
		expect(result.details).toMatchObject({ allowedTools: ["read"] });
	});

	it("respects maxTurns and returns an error", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());

		const responses: Array<ReturnType<typeof fauxAssistantMessage>> = [];
		for (let i = 0; i < 4; i++) {
			responses.push(fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" }));
		}
		faux.setResponses(responses);

		const result = await createTaskToolDefinition(baseOptions(faux.getModel())).execute(
			"id1",
			{ request: "loop forever", maxTurns: 2 },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Task subagent error") });
		expect(result.details).toMatchObject({ maxTurns: 2 });
	});

	it("returns an error message when no model is available", async () => {
		const result = await createTaskToolDefinition({
			cwd: process.cwd(),
			model: () => undefined,
			tools: [],
			delegatableToolNames: [],
		}).execute("id1", { request: "anything" }, undefined, undefined, {} as never);

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("no model available") });
	});

	it("DEFAULT_TASK_TOOLS includes the productive surface and excludes subagent tools", () => {
		expect(DEFAULT_TASK_TOOLS).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
		expect(DEFAULT_TASK_TOOLS).not.toContain("task");
		expect(DEFAULT_TASK_TOOLS).not.toContain("oracle");
		expect(DEFAULT_TASK_TOOLS).not.toContain("find_files");
	});

	it("exposes Amp-style description and guidelines", () => {
		const def = createTaskToolDefinition({
			cwd: process.cwd(),
			model: () => undefined,
			tools: [],
			delegatableToolNames: [],
		});
		expect(def.description).toContain("isolated subagent");
		expect(def.promptGuidelines?.some((g) => g.includes("self-contained"))).toBe(true);
		expect(def.promptGuidelines?.some((g) => g.includes("Restrict task tools"))).toBe(true);
	});
});
