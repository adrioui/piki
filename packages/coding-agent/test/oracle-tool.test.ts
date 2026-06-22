/**
 * Tests for the oracle tool.
 */

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentTool } from "../src/core/subagent/runtime.ts";
import { createOracleToolDefinition } from "../src/core/tools/oracle.ts";

describe("oracle tool", () => {
	const registrations: Array<() => void> = [];

	afterEach(() => {
		for (const unregister of registrations) {
			unregister();
		}
		registrations.length = 0;
	});

	function makeReadTool(calls: string[]): SubagentTool {
		return {
			name: "read",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_id, args) => {
				const a = args as Record<string, unknown>;
				calls.push(a.path as string);
				return `contents of ${a.path}`;
			},
		};
	}

	it("returns the oracle's final text answer", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("Prefer the simple option: extract a helper.")]);

		const result = await createOracleToolDefinition({
			cwd: process.cwd(),
			model: faux.getModel(),
			tools: [makeReadTool([])],
		}).execute("id1", { request: "How should I structure this?" }, undefined, undefined, {} as never);

		expect(result.content[0]).toMatchObject({ type: "text", text: "Prefer the simple option: extract a helper." });
	});

	it("lets the oracle call read-only tools and returns the final answer", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());
		const readCalls: string[] = [];
		const readTool = makeReadTool(readCalls);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "src/a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The code is fine. No changes needed."),
		]);

		const result = await createOracleToolDefinition({
			cwd: process.cwd(),
			model: faux.getModel(),
			tools: [readTool],
		}).execute("id1", { request: "Review src/a.ts" }, undefined, undefined, {} as never);

		expect(readCalls).toEqual(["src/a.ts"]);
		expect(result.content[0]).toMatchObject({ type: "text", text: "The code is fine. No changes needed." });
	});

	it("returns an error message when no model is available", async () => {
		const result = await createOracleToolDefinition({
			cwd: process.cwd(),
			model: () => undefined,
			tools: [],
		}).execute("id1", { request: "anything" }, undefined, undefined, {} as never);

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("no model available") });
	});

	it("surfaces subagent errors", async () => {
		const faux = registerFauxProvider();
		registrations.push(() => faux.unregister());

		// Force a max-turns exhaustion by always requesting a tool call.
		const looper: SubagentTool = {
			name: "read",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => "data",
		};
		const responses: Array<ReturnType<typeof fauxAssistantMessage>> = [];
		for (let i = 0; i < 3; i++) {
			responses.push(fauxAssistantMessage(fauxToolCall("read", { path: "x" }), { stopReason: "toolUse" }));
		}
		faux.setResponses(responses);

		const result = await createOracleToolDefinition({
			cwd: process.cwd(),
			model: faux.getModel(),
			tools: [looper],
			maxTurns: 2,
		}).execute("id1", { request: "loop" }, undefined, undefined, {} as never);

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Oracle subagent error") });
	});

	it("exposes an Amp-style expert-advisor description and guidelines", () => {
		const def = createOracleToolDefinition({ cwd: process.cwd(), model: () => undefined, tools: [] });
		expect(def.description).toContain("expert");
		expect(def.description).toContain("read-only");
		expect(def.promptGuidelines?.some((g) => g.includes("self-contained"))).toBe(true);
	});
});
