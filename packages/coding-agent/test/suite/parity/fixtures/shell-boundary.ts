import { fauxAssistantMessage, fauxText, fauxToolCall } from "@piki/ai/compat";
import type { ParityFixture } from "./types.ts";

/**
 * Canonical task exercising Magnitude alpha22's shell write-boundary:
 *  - write a README inside cwd            -> permitted
 *  - redirect a build log to /tmp         -> permitted (/tmp always allowed)
 *  - write a config into /etc             -> denied (outside allowed dirs)
 *
 * Mirrors alpha22 `denyWritesOutside`: roots = [cwd, scratchpadPath, ~/.piki],
 * with /tmp/ + /dev/null always permitted.
 */
export const shellBoundaryFixture: ParityFixture = {
	id: "shell-boundary",
	description: "cwd write allowed, /tmp redirect allowed, /etc write denied",
	prompt:
		"Set up the workspace: write README in cwd, redirect build log to /tmp/build.log, then create a config in /etc.",
	toolNames: ["bash", "read", "edit"],
	responses: [
		fauxAssistantMessage(
			[
				fauxText("Writing the README."),
				fauxToolCall("bash", { command: "echo '# Piki' > README.md" }, { id: "c1" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			[fauxText("Building."), fauxToolCall("bash", { command: "make > /tmp/build.log 2>&1" }, { id: "c2" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			[fauxText("Configuring."), fauxToolCall("bash", { command: "echo x > /etc/piki.conf" }, { id: "c3" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Done.", { stopReason: "stop" }),
	],
	expectedPermissions: [
		{ tool: { name: "bash", args: { command: "echo '# Piki' > README.md" } }, permitted: true },
		{ tool: { name: "bash", args: { command: "make > /tmp/build.log 2>&1" } }, permitted: true },
		{
			tool: { name: "bash", args: { command: "echo x > /etc/piki.conf" } },
			permitted: false,
			reason: "Command targets paths outside allowed directories",
		},
	],
	expectedAtif: {
		hasAssistantWithToolCalls: true,
		// user prompt + 3×(assistant + toolResult) + final assistant = 8 message entries
		totalSteps: 8,
		subagentTrajectoryCount: 0,
		forkIdPresent: false,
		llmCallCountPresent: true,
	},
};
