import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@piki/coding-agent";
import { isBunBinary } from "./config.ts";

interface PendingRequest {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
}

const require = createRequire(import.meta.url);

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export class RpcProcessInstance {
	readonly process: ChildProcess;

	private exited = false;
	private nextRequestId = 0;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly exitListeners = new Set<(error?: Error) => void>();
	private uiRequestHandler: ((request: RpcExtensionUIRequest) => void) | undefined;

	constructor(options: { cwd: string; provider?: string; model?: string }) {
		const rpcCommand = this.getSpawnCommand(options);
		this.process = spawn(rpcCommand.command, rpcCommand.args, {
			cwd: options.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!this.process.stdin || !this.process.stdout) {
			throw new Error("Failed to create RPC process stdio");
		}
		this.attachListeners();
	}

	private getSpawnCommand(options: { provider?: string; model?: string }): { command: string; args: string[] } {
		const args: string[] = ["--mode", "rpc"];
		if (options.provider !== undefined) {
			args.push("--provider", options.provider);
		}
		if (options.model !== undefined) {
			args.push("--model", options.model);
		}
		if (isBunBinary) {
			return {
				command: join(dirname(process.execPath), process.platform === "win32" ? "pi.exe" : "pi"),
				args,
			};
		}
		return {
			command: process.execPath,
			args: [require.resolve("@piki/coding-agent/rpc-entry"), ...args],
		};
	}

	private attachListeners(): void {
		this.process.stdout?.setEncoding("utf8");
		this.process.stdout?.on("data", (chunk: string) => {
			this.stdoutBuffer += chunk;
			while (true) {
				const newlineIndex = this.stdoutBuffer.indexOf("\n");
				if (newlineIndex === -1) {
					break;
				}
				const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
				this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
				if (!line) {
					continue;
				}
				this.handleLine(line);
			}
		});

		this.process.stderr?.setEncoding("utf8");
		this.process.stderr?.on("data", (chunk: string) => {
			this.stderrBuffer += chunk;
		});

		this.process.once("error", (error) => {
			this.exited = true;
			const wrapped = new Error(`RPC process error: ${error.message}. Stderr: ${this.stderrBuffer}`);
			this.rejectAllPending(wrapped);
			this.notifyExit(wrapped);
		});

		this.process.once("exit", (code, signal) => {
			this.exited = true;
			const error = new Error(`RPC process exited (code=${code} signal=${signal}). Stderr: ${this.stderrBuffer}`);
			this.rejectAllPending(error);
			this.notifyExit(error);
		});
	}

	private handleLine(line: string): void {
		let parsed: { type?: string; id?: string };
		try {
			parsed = JSON.parse(line) as { type?: string; id?: string };
		} catch {
			// Stray non-JSON line (e.g. a log line leaked to stdout). Skip it;
			// a crash here would take down the whole orchestrator daemon.
			process.stderr.write(`[orchestrator] skipping non-JSON RPC line: ${line.slice(0, 200)}\n`);
			return;
		}
		switch (parsed.type) {
			case "response": {
				if (!parsed.id) {
					return;
				}
				const pending = this.pendingRequests.get(parsed.id);
				if (!pending) {
					return;
				}
				this.pendingRequests.delete(parsed.id);
				pending.resolve(parsed as RpcResponse);
				return;
			}

			case "extension_ui_request": {
				this.uiRequestHandler?.(parsed as RpcExtensionUIRequest);
				return;
			}

			default: {
				for (const listener of this.eventListeners) {
					listener(parsed as AgentSessionEvent);
				}
			}
		}
	}

	private rejectAllPending(error: Error): void {
		for (const [id, pending] of this.pendingRequests) {
			this.pendingRequests.delete(id);
			pending.reject(error);
		}
	}

	private notifyExit(error?: Error): void {
		for (const listener of this.exitListeners) {
			listener(error);
		}
	}

	send(command: RpcCommand): Promise<RpcResponse> {
		if (this.exited) {
			throw new Error(`RPC process is not running. Stderr: ${this.stderrBuffer}`);
		}
		const id = command.id ?? `orchestrator_${++this.nextRequestId}_${randomUUID()}`;
		const fullCommand = { ...command, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.process.stdin?.write(`${JSON.stringify(fullCommand)}\n`, (error) => {
				if (!error) {
					return;
				}
				this.pendingRequests.delete(id);
				reject(toError(error));
			});
		});
	}

	handleUiResponse(response: RpcExtensionUIResponse): void {
		if (this.exited) {
			return;
		}
		this.process.stdin?.write(`${JSON.stringify(response)}\n`);
	}

	setUiRequestHandler(handler?: (request: RpcExtensionUIRequest) => void): void {
		this.uiRequestHandler = handler;
	}

	onEvent(listener: (event: AgentSessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	onExit(listener: (error?: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	async dispose(): Promise<void> {
		this.uiRequestHandler = undefined;
		this.rejectAllPending(new Error("RPC process disposed"));
		if (this.exited) {
			return;
		}
		this.process.kill("SIGTERM");
		const exited = await new Promise<boolean>((resolve) => {
			let settled = false;
			const onExit = () => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(true);
			};
			this.process.once("exit", onExit);
			setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(false);
			}, 5000);
		});
		if (!exited) {
			this.process.kill("SIGKILL");
			await new Promise<void>((resolve) => {
				this.process.once("exit", () => resolve());
			});
		}
	}
}

export function createRpcProcessInstance(options: {
	cwd: string;
	provider?: string;
	model?: string;
}): RpcProcessInstance {
	return new RpcProcessInstance(options);
}
