/**
 * Auto-detach long-running commands into their own process group.
 *
 * When a command is classified as long-running and no explicit timeout is set,
 * this module spawns the command in its own process group, redirects output to
 * a temp log file, and returns pid/logpath metadata immediately. The caller
 * does not block waiting for the process to exit.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess, spawn } from "child_process";
import { getShellConfig, getShellEnv, trackDetachedChildPid } from "../utils/shell.ts";

/**
 * Metadata returned for an auto-detached command.
 */
export interface AutoDetachResult {
	/** Whether the command was auto-detached. */
	detached: true;
	/** Process ID of the detached command. */
	pid: number;
	/** Path to the temp log file containing command output. */
	logPath: string;
	/** Description of why the command was auto-detached. */
	reason: string;
	/** Unix epoch milliseconds when the command was started. */
	startedAt: number;
}

/**
 * Spawn a command in its own process group, redirecting stdout/stderr to a
 * temp log file. Returns immediately with pid and log metadata.
 *
 * @param command - The bash command to execute
 * @param cwd - Working directory
 * @param reason - Why the command is being detached (for display)
 * @param shellPath - Optional explicit shell path
 * @returns Metadata about the detached process
 */
export function spawnDetached(
	command: string,
	cwd: string,
	reason: string,
	shellPath?: string,
	scratchpadPath?: string,
): AutoDetachResult {
	const shellConfig = getShellConfig(shellPath);
	const id = randomBytes(8).toString("hex");
	const logPath = join(tmpdir(), `pi-detached-${id}.log`);
	const logStream = createWriteStream(logPath);

	const commandFromStdin = shellConfig.commandTransport === "stdin";
	const child: ChildProcess = spawn(
		shellConfig.shell,
		commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
		{
			cwd,
			detached: process.platform !== "win32",
			env: { ...getShellEnv(undefined, scratchpadPath), NO_COLOR: "1", PROJECT_ROOT: cwd },
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);

	if (commandFromStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(command);
	}

	const pid = child.pid!;

	// Pipe stdout and stderr to the log file
	child.stdout?.pipe(logStream, { end: false });
	child.stderr?.pipe(logStream, { end: false });

	// When the child exits, close the log stream
	child.on("close", () => {
		logStream.end();
	});

	// Unref the child so it doesn't keep the parent process alive
	child.unref();

	// Track the PID for cleanup on shutdown
	trackDetachedChildPid(pid);

	return {
		detached: true,
		pid,
		logPath,
		reason,
		startedAt: Date.now(),
	};
}
