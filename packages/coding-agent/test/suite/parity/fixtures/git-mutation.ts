import { fauxAssistantMessage, fauxText, fauxToolCall } from "@piki/ai/compat";
import type { ParityFixture } from "./types.ts";

/**
 * Canonical task exercising git-mutation classification (T1) against mag alpha22.
 * The leader runs `git -c user.name=x status` which alpha22 treats as a
 * mutating/config-override command and blocks. piki now classifies it as a
 * denied mutating git command via `evaluatePermission`'s git gate.
 */
export const gitMutationFixture: ParityFixture = {
	id: "git-mutation",
	description: "git -c config override is blocked (T1); read-only git allowed",
	prompt: "Check git status with a config override, then show the log.",
	toolNames: ["bash"],
	responses: [
		fauxAssistantMessage(
			[fauxText("Checking status."), fauxToolCall("bash", { command: "git -c user.name=x status" }, { id: "g1" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			[fauxText("Showing log."), fauxToolCall("bash", { command: "git log --oneline" }, { id: "g2" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Done.", { stopReason: "stop" }),
	],
	expectedPermissions: [
		{
			tool: { name: "bash", args: { command: "git -c user.name=x status" } },
			permitted: false,
			reason: "git command uses config or execution-affecting flags",
		},
		{ tool: { name: "bash", args: { command: "git log --oneline" } }, permitted: true },
	],
};
