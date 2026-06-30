import { callDaemon, readDaemonPid } from "./daemon/daemon-mode.ts";

export type ParsedDaemonCommand =
	| { kind: "none" }
	| { kind: "start"; remainingArgs: string[]; socketPath?: string }
	| { kind: "status"; socketPath?: string }
	| { kind: "stop"; socketPath?: string }
	| { kind: "threads"; socketPath?: string }
	| { kind: "state"; threadId: string; socketPath?: string }
	| { kind: "submit"; threadId: string; message: string; cwd?: string; socketPath?: string };

function takeFlag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("-")) {
		throw new Error(`${name} requires a value`);
	}
	args.splice(index, 2);
	return value;
}

export function parseDaemonCommand(args: string[]): ParsedDaemonCommand {
	if (args[0] !== "daemon") {
		return { kind: "none" };
	}
	const rest = args.slice(1);
	const socketPath = takeFlag(rest, "--socket");
	const subcommand = rest[0] ?? "start";

	if (subcommand === "status") {
		return { kind: "status", socketPath };
	}
	if (subcommand === "stop") {
		return { kind: "stop", socketPath };
	}
	if (subcommand === "threads") {
		return { kind: "threads", socketPath };
	}
	if (subcommand === "state") {
		const threadId = takeFlag(rest, "--thread") ?? rest[1];
		if (!threadId) {
			throw new Error('daemon state requires "--thread <id>"');
		}
		return { kind: "state", threadId, socketPath };
	}
	if (subcommand === "submit") {
		const flagThreadId = takeFlag(rest, "--thread");
		const cwd = takeFlag(rest, "--cwd");
		const threadId = flagThreadId ?? rest[1];
		const messageParts = flagThreadId ? rest.slice(1) : rest.slice(2);
		const message = messageParts.join(" ").trim();
		if (!threadId) {
			throw new Error('daemon submit requires "--thread <id>"');
		}
		if (!message) {
			throw new Error("daemon submit requires a message");
		}
		return { kind: "submit", threadId, message, cwd, socketPath };
	}

	const remainingArgs = subcommand === "start" ? rest.slice(1) : rest;
	return { kind: "start", remainingArgs, socketPath };
}

export async function handleDaemonClientCommand(command: ParsedDaemonCommand): Promise<boolean> {
	try {
		switch (command.kind) {
			case "none":
			case "start":
				return false;
			case "status": {
				const health = await callDaemon({ method: "GET", path: "/health", socketPath: command.socketPath });
				console.log(
					JSON.stringify(
						{
							pid: readDaemonPid(),
							health,
						},
						null,
						2,
					),
				);
				return true;
			}
			case "stop":
				console.log(
					JSON.stringify(
						await callDaemon({ method: "POST", path: "/shutdown", socketPath: command.socketPath }),
						null,
						2,
					),
				);
				return true;
			case "threads":
				console.log(
					JSON.stringify(
						await callDaemon({ method: "GET", path: "/threads", socketPath: command.socketPath }),
						null,
						2,
					),
				);
				return true;
			case "state":
				console.log(
					JSON.stringify(
						await callDaemon({
							method: "GET",
							path: `/thread/${encodeURIComponent(command.threadId)}/state`,
							socketPath: command.socketPath,
						}),
						null,
						2,
					),
				);
				return true;
			case "submit":
				console.log(
					JSON.stringify(
						await callDaemon({
							method: "POST",
							path: `/thread/${encodeURIComponent(command.threadId)}/prompt`,
							body: { message: command.message, cwd: command.cwd },
							socketPath: command.socketPath,
						}),
						null,
						2,
					),
				);
				return true;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return true;
	}
}
