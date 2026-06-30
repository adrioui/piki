import { describe, expect, it } from "vitest";
import { parseDaemonCommand } from "../src/daemon-cli.ts";

describe("parseDaemonCommand", () => {
	it("parses daemon start args", () => {
		const parsed = parseDaemonCommand(["daemon", "start", "--provider", "opencode-go", "--model", "deepseek-v4-pro"]);
		expect(parsed.kind).toBe("start");
		if (parsed.kind !== "start") return;
		expect(parsed.remainingArgs).toEqual(["--provider", "opencode-go", "--model", "deepseek-v4-pro"]);
	});

	it("parses daemon submit args", () => {
		const parsed = parseDaemonCommand([
			"daemon",
			"submit",
			"--thread",
			"demo",
			"--cwd",
			"/tmp/project",
			"inspect",
			"repo",
		]);
		expect(parsed).toEqual({
			kind: "submit",
			threadId: "demo",
			cwd: "/tmp/project",
			message: "inspect repo",
			socketPath: undefined,
		});
	});

	it("preserves thread id words in submit messages", () => {
		const parsed = parseDaemonCommand(["daemon", "submit", "--thread", "demo", "fix", "the", "demo", "bug"]);
		expect(parsed).toEqual({
			kind: "submit",
			threadId: "demo",
			cwd: undefined,
			message: "fix the demo bug",
			socketPath: undefined,
		});
	});
});
