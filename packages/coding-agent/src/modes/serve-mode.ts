import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { createHeadlessExtensionUIContext } from "./headless-extension-ui.ts";

export interface ServeModeOptions {
	port: number;
	host?: string;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(`${JSON.stringify(payload)}\n`);
}

function writeCors(response: ServerResponse): void {
	response.setHeader("access-control-allow-origin", "*");
	response.setHeader("access-control-allow-headers", "Content-Type, Authorization, Last-Event-ID");
	response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
}

function sseFrame(id: string, event: string, data: unknown): string {
	return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function timingSafeStringEqual(left: string | null | undefined, right: string): boolean {
	if (typeof left !== "string") return false;
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(request: IncomingMessage, url: URL, token: string): boolean {
	const header = request.headers.authorization;
	const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
	return timingSafeStringEqual(bearer, token) || timingSafeStringEqual(url.searchParams.get("token"), token);
}

function snapshot(runtimeHost: AgentSessionRuntime) {
	const session = runtimeHost.session;
	return {
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		cwd: session.sessionManager.getCwd(),
		model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
		isStreaming: session.isStreaming,
		isRetrying: session.isRetrying,
		pendingMessageCount: session.pendingMessageCount,
		sessionName: session.sessionManager.getSessionName(),
		lastAssistantText: session.getLastAssistantText(),
	};
}

async function bindHeadlessExtensions(runtimeHost: AgentSessionRuntime): Promise<void> {
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
				throw new Error("Reload is not available in serve mode");
			},
		},
		shutdownHandler: () => {},
		onError: () => {},
	});
}

export async function runServeMode(runtimeHost: AgentSessionRuntime, options: ServeModeOptions): Promise<void> {
	await bindHeadlessExtensions(runtimeHost);

	const sseClients = new Set<ServerResponse>();
	const eventHistory: Array<{
		id: string;
		event: string;
		data: unknown;
		sessionId: string;
	}> = [];
	const configuredToken = process.env.PI_SERVE_TOKEN?.trim();
	const authToken = configuredToken && configuredToken.length > 0 ? configuredToken : randomUUID();
	let eventSequence = 0;
	const recordEvent = (event: string, data: unknown, sessionId = runtimeHost.session.sessionId) => {
		const id = String(++eventSequence);
		const entry = { id, event, data, sessionId };
		eventHistory.push(entry);
		eventHistory.splice(0, Math.max(0, eventHistory.length - 1000));
		return entry;
	};
	const broadcast = (event: string, data: unknown, sessionId = runtimeHost.session.sessionId) => {
		const entry = recordEvent(event, data, sessionId);
		for (const client of sseClients) {
			client.write(sseFrame(entry.id, event, data));
		}
	};
	let unsubscribe = runtimeHost.session.subscribe((event) => {
		broadcast(event.type, event);
	});

	runtimeHost.setRebindSession(async () => {
		unsubscribe();
		await bindHeadlessExtensions(runtimeHost);
		unsubscribe = runtimeHost.session.subscribe((event) => {
			broadcast(event.type, event);
		});
	});

	const server = createServer(async (request, response) => {
		try {
			writeCors(response);
			if (request.method === "OPTIONS") {
				response.statusCode = 204;
				response.end();
				return;
			}
			if (!request.url) {
				writeJson(response, 400, { error: "Missing request URL" });
				return;
			}
			const url = new URL(request.url, "http://127.0.0.1");
			if (url.pathname !== "/health" && !isAuthorized(request, url, authToken)) {
				writeJson(response, 401, { error: "Unauthorized" });
				return;
			}

			if (request.method === "GET" && url.pathname === "/health") {
				writeJson(response, 200, { ok: true });
				return;
			}

			if (request.method === "GET" && url.pathname === "/state") {
				writeJson(response, 200, snapshot(runtimeHost));
				return;
			}

			if (request.method === "GET" && url.pathname === "/sessions") {
				writeJson(response, 200, [{ ...snapshot(runtimeHost) }]);
				return;
			}

			const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(events|messages|interrupt))?$/);
			if (request.method === "GET" && sessionMatch && !sessionMatch[2]) {
				if (sessionMatch[1] !== runtimeHost.session.sessionId) {
					writeJson(response, 404, { error: "Session not found" });
					return;
				}
				writeJson(response, 200, snapshot(runtimeHost));
				return;
			}

			if (
				request.method === "GET" &&
				(url.pathname === "/events" || (sessionMatch && sessionMatch[2] === "events"))
			) {
				const sessionId = sessionMatch?.[1];
				response.statusCode = 200;
				response.setHeader("content-type", "text/event-stream");
				response.setHeader("cache-control", "no-cache");
				response.setHeader("connection", "keep-alive");
				const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 5000);
				const lastId = request.headers["last-event-id"];
				const lastIndex = typeof lastId === "string" ? eventHistory.findIndex((entry) => entry.id === lastId) : -1;
				const replay =
					typeof lastId === "string" ? (lastIndex >= 0 ? eventHistory.slice(lastIndex + 1) : eventHistory) : [];
				for (const entry of replay) {
					if (!sessionId || entry.sessionId === sessionId)
						response.write(sseFrame(entry.id, entry.event, entry.data));
				}
				const connected = recordEvent("connected", {
					type: "connected",
					...snapshot(runtimeHost),
				});
				response.write(sseFrame(connected.id, connected.event, connected.data));
				sseClients.add(response);
				request.on("close", () => {
					clearInterval(heartbeat);
					sseClients.delete(response);
				});
				return;
			}

			if (
				request.method === "POST" &&
				(url.pathname === "/prompt" || (sessionMatch && sessionMatch[2] === "messages"))
			) {
				const body = await readJsonBody(request);
				const message = typeof body.message === "string" ? body.message : undefined;
				if (!message) {
					writeJson(response, 400, { error: 'Missing "message"' });
					return;
				}
				void runtimeHost.session.prompt(message).catch((error) => {
					broadcast("error", {
						type: "error",
						message: error instanceof Error ? error.message : String(error),
					});
				});
				writeJson(response, 202, { accepted: true });
				return;
			}

			if (request.method === "POST" && url.pathname === "/steer") {
				const body = await readJsonBody(request);
				const message = typeof body.message === "string" ? body.message : undefined;
				if (!message) {
					writeJson(response, 400, { error: 'Missing "message"' });
					return;
				}
				await runtimeHost.session.steer(message);
				writeJson(response, 202, { accepted: true });
				return;
			}

			if (request.method === "POST" && url.pathname === "/follow-up") {
				const body = await readJsonBody(request);
				const message = typeof body.message === "string" ? body.message : undefined;
				if (!message) {
					writeJson(response, 400, { error: 'Missing "message"' });
					return;
				}
				await runtimeHost.session.followUp(message);
				writeJson(response, 202, { accepted: true });
				return;
			}

			if (
				request.method === "POST" &&
				(url.pathname === "/abort" || (sessionMatch && sessionMatch[2] === "interrupt"))
			) {
				await runtimeHost.session.abort();
				writeJson(response, 200, { aborted: true });
				return;
			}

			if (request.method === "DELETE" && sessionMatch && !sessionMatch[2]) {
				if (sessionMatch[1] !== runtimeHost.session.sessionId) {
					writeJson(response, 404, { error: "Session not found" });
					return;
				}
				await runtimeHost.session.abort();
				writeJson(response, 202, { deleted: true });
				return;
			}

			if (request.method === "POST" && url.pathname === "/session/new") {
				const body = await readJsonBody(request);
				const parentSession = typeof body.parentSession === "string" ? body.parentSession : undefined;
				const result = await runtimeHost.newSession({ parentSession });
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
		server.listen(options.port, options.host ?? "127.0.0.1", () => resolve());
	});

	console.error(`Serve mode listening on http://${options.host ?? "127.0.0.1"}:${options.port}`);
	console.error(`Serve mode bearer token: ${authToken}`);

	await new Promise<void>((resolve, reject) => {
		const shutdown = async () => {
			unsubscribe();
			for (const client of sseClients) {
				client.end();
			}
			await runtimeHost.dispose();
			server.close((error) => {
				if (error) reject(error);
				else resolve();
			});
		};
		process.once("SIGINT", () => void shutdown());
		process.once("SIGTERM", () => void shutdown());
	});
}
