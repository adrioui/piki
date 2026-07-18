import { fauxAssistantMessage, fauxText, fauxToolCall } from "@piki/ai/compat";
import type { ParityFixture } from "./types.ts";

/**
 * Canonical read-then-edit task. Both `read` and `edit` are built-in
 * allowed tools, so both calls are permitted. This fixture asserts the
 * ATIF step sequence (user + 2 assistant turns) and that `total_steps`
 * counts every message entry including the leading user step (S5 fix).
 */
export const readEditFixture: ParityFixture = {
	id: "read-edit",
	description: "read then edit, both permitted; total_steps counts all message entries",
	prompt: "Read src/app.ts then change the title.",
	toolNames: ["read", "edit"],
	responses: [
		fauxAssistantMessage([fauxText("Reading."), fauxToolCall("read", { path: "src/app.ts" }, { id: "r1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(
			[
				fauxText("Editing."),
				fauxToolCall(
					"edit",
					{ path: "src/app.ts", old: "<title>A</title>", new: "<title>B</title>" },
					{ id: "e1" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Done.", { stopReason: "stop" }),
	],
	expectedPermissions: [
		{ tool: { name: "read", args: { path: "src/app.ts" } }, permitted: true },
		{
			tool: { name: "edit", args: { path: "src/app.ts", old: "<title>A</title>", new: "<title>B</title>" } },
			permitted: true,
		},
	],
	expectedAtif: {
		// Tool-result entries are merged into their preceding agent step in
		// alpha22 export, so the six root message entries collapse to one user
		// step and three agent steps (two tool-calling turns + final assistant).
		stepTypes: ["user", "agent", "agent", "agent"],
		hasAssistantWithToolCalls: true,
		// user prompt + 2×(assistant + toolResult) + final assistant = 6 message entries
		totalSteps: 6,
		subagentTrajectoryCount: 0,
		forkIdPresent: false,
		llmCallCountPresent: true,
	},
};
