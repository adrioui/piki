import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { getDaemonDir, getDaemonPidPath, getDaemonSocketPath } from "../config.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../core/agent-session-runtime.ts";
import { SessionManager } from "../core/session-manager.ts";
import { createHeadlessExtensionUIContext } from "../modes/headless-extension-ui.ts";

export interface DaemonModeOptions {
	agentDir: string;
	defaultCwd: string;
	sessionDir?: string;
	socketPath?: string;
}

interface DaemonThreadState {
	threadId: string;
	cwd: string;
	runtimeHost: AgentSessionRuntime;
	queue: Promise<void>;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}

function threadSessionDir(baseDir: string): string {
	return join(baseDir, "sessions");
}

function threadLogPath(baseDir: string, threadId: string): string {
	return join(baseDir, "threads", `${threadId}.log`);
}

function isProcessAlive(pidPath: string): boolean {
	if (!existsSync(pidPath)) return false;
	const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function ensureParentDir(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

async function bindHeadless(runtimeHost: AgentSessionRuntime): Promise<void> {
	const session = runtimeHost.session;
	await session.bindExtensions({
		uiContext: createHeadlessExtensionUIContext(),
		mode: "rpc",
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: async (options) => runtimeHost.newSession(options),
			fork: async (entryId, forkOptions) => runtimeHost.fork(entryId, forkOptions),
			navigateTree: async (targetId, navigateOptions) => {
				const result = await session.navigateTree(targetId, {
					summarize: navigateOptions?.summarize,
					customInstructions: navigateOptions?.customInstructions,
					replaceInstructions: navigateOptions?.replaceInstructions,
					label: navigateOptions?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath, switchOptions) => runtimeHost.switchSession(sessionPath, switchOptions),
			reload: async () => {
				throw new Error("Reload is not available in daemon mode");
			},
		},
		shutdownHandler: () => {},
		onError: () => {},
	});
}

function snapshot(runtimeHost: AgentSessionRuntime, threadId: string, cwd: string) {
	const session = runtimeHost.session;
	return {
		threadId,
		cwd,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
		isStreaming: session.isStreaming,
		isRetrying: session.isRetrying,
		pendingMessageCount: session.pendingMessageCount,
		lastAssistantText: session.getLastAssistantText(),
	};
}

async function findThreadSession(threadId: string, cwd: string, sessionDir: string): Promise<SessionManager> {
	const sessions = await SessionManager.list(cwd, sessionDir);
	const existing = sessions.find((session) => session.id === threadId);
	if (existing) {
		return SessionManager.open(existing.path, sessionDir);
	}
	return SessionManager.create(cwd, sessionDir, { id: threadId });
}

async function ensureThread(
	threads: Map<string, DaemonThreadState>,
	threadCreations: Map<string, Promise<DaemonThreadState>>,
	threadId: string,
	cwd: string,
	createRuntime: CreateAgentSessionRuntimeFactory,
	agentDir: string,
	baseDir: string,
): Promise<DaemonThreadState> {
	const existing = threads.get(threadId);
	if (existing) return existing;
	const pending = threadCreations.get(threadId);
	if (pending) return await pending;

	const creation = (async () => {
		const sessionDir = threadSessionDir(baseDir);
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}
		const sessionManager = await findThreadSession(threadId, cwd, sessionDir);
		const result = await createRuntime({
			cwd: sessionManager.getCwd(),
			agentDir,
			sessionManager,
		});
		const runtimeHost = new AgentSessionRuntime(
			result.session,
			result.services,
			createRuntime,
			result.diagnostics,
			result.modelFallbackMessage,
		);
		try {
			await bindHeadless(runtimeHost);
			runtimeHost.setRebindSession(async () => {
				await bindHeadless(runtimeHost);
			});
			const state: DaemonThreadState = {
				threadId,
				cwd,
				runtimeHost,
				queue: Promise.resolve(),
			};
			threads.set(threadId, state);
			return state;
		} catch (error) {
			await runtimeHost.dispose();
			throw error;
		}
	})();
	threadCreations.set(threadId, creation);
	try {
		return await creation;
	} finally {
		threadCreations.delete(threadId);
	}
}

async function threadPrompt(
	thread: DaemonThreadState,
	message: string,
	logFile: string,
): Promise<ReturnType<typeof snapshot>> {
	const promptRun = thread.queue
		.catch(() => {})
		.then(async () => {
			appendFileSync(
				logFile,
				`${JSON.stringify({ timestamp: new Date().toISOString(), event: "prompt", message })}\n`,
			);
			await thread.runtimeHost.session.prompt(message);
			await thread.runtimeHost.session.waitForIdle();
			appendFileSync(
				logFile,
				`${JSON.stringify({
					timestamp: new Date().toISOString(),
					event: "idle",
					lastAssistantText: thread.runtimeHost.session.getLastAssistantText(),
				})}\n`,
			);
		});
	thread.queue = promptRun.catch(() => {});
	await promptRun;
	return snapshot(thread.runtimeHost, thread.threadId, thread.cwd);
}

export async function runDaemonMode(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: DaemonModeOptions,
): Promise<void> {
	const socketPath = options.socketPath ?? getDaemonSocketPath();
	const baseDir = getDaemonDir();
	if (!existsSync(baseDir)) {
		mkdirSync(baseDir, { recursive: true });
	}
	const pidPath = getDaemonPidPath();
	if (existsSync(socketPath)) {
		if (isProcessAlive(pidPath)) {
			throw new Error(`Daemon already appears to be running at ${socketPath}`);
		}
		rmSync(socketPath, { force: true });
	}
	writeFileSync(pidPath, `${process.pid}\n`);

	const threads = new Map<string, DaemonThreadState>();
	const threadCreations = new Map<string, Promise<DaemonThreadState>>();
	const server = createServer(async (request, response) => {
		try {
			if (!request.url) {
				writeJson(response, 400, { error: "Missing request URL" });
				return;
			}
			if (request.method === "GET" && request.url === "/health") {
				writeJson(response, 200, {
					ok: true,
					pid: process.pid,
					threadCount: threads.size,
				});
				return;
			}
			if (request.method === "GET" && request.url === "/threads") {
				writeJson(response, 200, {
					threads: Array.from(threads.values()).map((thread) =>
						snapshot(thread.runtimeHost, thread.threadId, thread.cwd),
					),
				});
				return;
			}
			if (request.method === "POST" && request.url === "/shutdown") {
				writeJson(response, 200, { stopping: true });
				process.nextTick(() => {
					server.close();
				});
				return;
			}
			const threadMatch = request.url.match(/^\/thread\/([^/]+)\/(state|prompt)$/);
			if (!threadMatch) {
				writeJson(response, 404, { error: "Not found" });
				return;
			}
			const [, rawThreadId, action] = threadMatch;
			const threadId = decodeURIComponent(rawThreadId);
			const body = request.method === "POST" ? await readJsonBody(request) : {};
			const cwd = typeof body.cwd === "string" ? body.cwd : options.defaultCwd;
			const thread = await ensureThread(
				threads,
				threadCreations,
				threadId,
				cwd,
				createRuntime,
				options.agentDir,
				baseDir,
			);
			if (action === "state") {
				writeJson(response, 200, snapshot(thread.runtimeHost, threadId, thread.cwd));
				return;
			}
			if (action === "prompt") {
				const message = typeof body.message === "string" ? body.message : undefined;
				if (!message) {
					writeJson(response, 400, { error: 'Missing "message"' });
					return;
				}
				const logPath = threadLogPath(baseDir, threadId);
				ensureParentDir(logPath);
				const result = await threadPrompt(thread, message, logPath);
				writeJson(response, 200, result);
				return;
			}
			writeJson(response, 404, { error: "Not found" });
		} catch (error) {
			writeJson(response, 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	console.error(`Daemon listening on ${socketPath}`);

	await new Promise<void>((resolve) => {
		server.once("close", resolve);
	});

	for (const thread of threads.values()) {
		await thread.runtimeHost.dispose();
	}
	rmSync(socketPath, { force: true });
	rmSync(pidPath, { force: true });
}

export async function callDaemon(options: {
	method: "GET" | "POST";
	path: string;
	body?: Record<string, unknown>;
	socketPath?: string;
}): Promise<unknown> {
	const socketPath = options.socketPath ?? getDaemonSocketPath();
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				socketPath,
				path: options.path,
				method: options.method,
				headers: options.body ? { "content-type": "application/json" } : undefined,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => {
					chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
				});
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf-8").trim();
					if (!text) {
						resolve(undefined);
						return;
					}
					try {
						const parsed = JSON.parse(text) as Record<string, unknown>;
						if (response.statusCode && response.statusCode >= 400) {
							reject(new Error(String(parsed.error ?? `Daemon request failed with ${response.statusCode}`)));
							return;
						}
						resolve(parsed);
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.once("error", reject);
		if (options.body) {
			req.write(JSON.stringify(options.body));
		}
		req.end();
	});
}

export function readDaemonPid(): number | undefined {
	const pidPath = getDaemonPidPath();
	if (!existsSync(pidPath)) return undefined;
	const value = readFileSync(pidPath, "utf-8").trim();
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}
