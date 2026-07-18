import { fauxAssistantMessage, fauxText, fauxToolCall } from "@piki/ai/compat";
import type { ParityFixture } from "./types.ts";

/**
 * Canonical task exercising the LEADER write-boundary (G1) and
 * `--disable-cwd-safeguards` (G2) against mag alpha22.
 *
 * The leader now applies the `leader` role policy via `evaluatePermission`
 * (roleId:"leader", scratchpadPath), so `write`/`edit`/`edit-diff` outside the
 * cwd are rejected with the role-policy reason — matching alpha22's
 * `denyWritesOutside`. The fixture asserts:
 *   - write to /etc/piki.conf  -> denied (role policy, cwd boundary)
 *   - write to ./README.md     -> permitted
 * A second variant (options.disableCwdSafeguards: true) flips the /etc write
 * to permitted, proving G2 is a real, independent toggle.
 */
export const leaderWriteBoundaryFixture: ParityFixture = {
	id: "leader-write-boundary",
	description: "leader write to /etc denied (cwd boundary), ./README.md permitted, disable-cwd flips /etc to allowed",
	prompt: "Write the config to /etc/piki.conf and the README to the project dir.",
	toolNames: ["write", "edit", "bash"],
	responses: [
		fauxAssistantMessage(
			[
				fauxText("Writing the config."),
				fauxToolCall("write", { path: "/etc/piki.conf", content: "x" }, { id: "w1" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			[
				fauxText("Writing the README."),
				fauxToolCall("write", { path: "README.md", content: "# Piki" }, { id: "w2" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Done.", { stopReason: "stop" }),
	],
	expectedPermissions: [
		{
			tool: { name: "write", args: { path: "/etc/piki.conf", content: "x" } },
			permitted: false,
			reason: "Cannot write files outside allowed directories",
		},
		{ tool: { name: "write", args: { path: "README.md", content: "# Piki" } }, permitted: true },
	],
	expectedAtif: {
		hasAssistantWithToolCalls: true,
		// user + 2 assistants(write /etc denied→no toolResult, write README) + 1 toolResult + final assistant = 6 message entries
		totalSteps: 6,
		subagentTrajectoryCount: 0,
		forkIdPresent: false,
		llmCallCountPresent: true,
	},
};

/**
 * Variant with `--disable-cwd-safeguards` semantics: the leader cwd boundary
 * is lifted, so the /etc write is now permitted (proves G2 is effective).
 */
export const leaderWriteBoundaryDisabledFixture: ParityFixture = {
	id: "leader-write-boundary-disabled",
	description: "with disableCwdSafeguards, leader write to /etc is permitted",
	prompt: "Write the config to /etc/piki.conf.",
	toolNames: ["write", "bash"],
	responses: [
		fauxAssistantMessage(
			[
				fauxText("Writing the config."),
				fauxToolCall("write", { path: "/etc/piki.conf", content: "x" }, { id: "w1" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Done.", { stopReason: "stop" }),
	],
	expectedPermissions: [{ tool: { name: "write", args: { path: "/etc/piki.conf", content: "x" } }, permitted: true }],
	options: { disableCwdSafeguards: true },
};
