/**
 * `pi serve` — read-only local HTTP server with SSE.
 *
 * Routes:
 *   GET /health              — Health check
 *   GET /sessions            — List all sessions
 *   GET /sessions/:id        — Get session metadata
 *   GET /sessions/:id/messages — Get session messages
 *   GET /sessions/:id/events  — Get session events (SSE)
 *   GET /events              — Global event stream (SSE)
 *
 * SSE frame format:
 *   id: N
 *   event: <type>
 *   data: <json>
 *
 * Heartbeat: every 5 seconds.
 * Last-Event-ID: replay from .events.jsonl where possible.
 */

import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { getSessionsDir } from "../config.ts";
import {
	loadEntriesFromFile,
	type SessionEntry,
	type SessionHeader,
	type SessionInfo,
	type SessionMessageEntry,
} from "./session-manager.ts";

// ============================================================================
// Types
// ============================================================================

export interface ServeOptions {
	/** Port to listen on. Default: 3117 */
	port?: number;
	/** Host to bind to. Default: "127.0.0.1" */
	host?: string;
	/** Session directory override */
	sessionDir?: string;
	/** Working directory for session lookup */
	cwd?: string;
	/** Bearer token for authentication. When set, all requests except /health must include a matching Authorization header. */
	token?: string;
}

// ============================================================================
// Authentication
// ============================================================================

/**
 * Constant-time comparison for bearer tokens.
 * Returns true if the request is authenticated (or no token is configured).
 */
function authenticateRequest(req: IncomingMessage, token?: string): boolean {
	if (!token) return true;
	const expectedToken = token.trim();
	if (!expectedToken) return true;

	const authHeader = req.headers.authorization;
	if (!authHeader) return false;

	// Extract Bearer token
	const match = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;

	const providedToken = match[1]?.trim();
	if (!providedToken) return false;

	// Constant-time comparison to prevent timing side-channel attacks
	const expectedBuf = Buffer.from(expectedToken, "utf-8");
	const providedBuf = Buffer.from(providedToken, "utf-8");

	if (expectedBuf.length !== providedBuf.length) return false;

	return timingSafeEqual(expectedBuf, providedBuf);
}

// ============================================================================
// Route parsing
// ============================================================================

function parseUrl(url: string): { pathname: string; query: Record<string, string> } {
	const [pathname, queryString] = url.split("?", 2);
	const query: Record<string, string> = {};
	if (queryString) {
		for (const pair of queryString.split("&")) {
			const [key, value] = pair.split("=", 2);
			if (key) {
				query[decodeURIComponent(key)] = value ? decodeURIComponent(value) : "";
			}
		}
	}
	return { pathname: pathname || "/", query };
}

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
	const pathParts = pathname.split("/").filter(Boolean);
	const patternParts = pattern.split("/").filter(Boolean);

	if (pathParts.length !== patternParts.length) return null;

	const params: Record<string, string> = {};
	for (let i = 0; i < patternParts.length; i++) {
		const patternPart = patternParts[i]!;
		const pathPart = pathParts[i]!;
		if (patternPart.startsWith(":")) {
			params[patternPart.slice(1)] = pathPart;
		} else if (patternPart !== pathPart) {
			return null;
		}
	}
	return params;
}

// ============================================================================
// Session helpers
// ============================================================================

function listSessionInfos(sessionDir: string, _cwd?: string): SessionInfo[] {
	const sessions: SessionInfo[] = [];
	if (!existsSync(sessionDir)) return sessions;

	try {
		const files = require("node:fs")
			.readdirSync(sessionDir)
			.filter((f: string) => f.endsWith(".jsonl"))
			.map((f: string) => join(sessionDir, f));

		for (const file of files) {
			try {
				const info = buildSessionInfoFromSync(file);
				if (info) sessions.push(info);
			} catch {
				// Skip unreadable sessions
			}
		}
	} catch {
		// Return empty on error
	}

	return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

function buildSessionInfoFromSync(filePath: string): SessionInfo | null {
	if (!existsSync(filePath)) return null;

	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n").filter((l) => l.trim());

		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		let lastMessage = "";
		let name: string | undefined;

		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as SessionHeader | SessionEntry;
				if (entry.type === "session") {
					header = entry as SessionHeader;
				} else if (entry.type === "session_info") {
					name = (entry as { name?: string }).name?.trim() || undefined;
				} else if (entry.type === "message") {
					const msg = (entry as { message: { role: string; content: unknown } }).message;
					if (msg.role === "user" || msg.role === "assistant") {
						messageCount++;
						const text = extractTextFromContent(msg.content);
						if (text) {
							if (!firstMessage && msg.role === "user") firstMessage = text;
							lastMessage = text;
						}
					}
				}
			} catch {
				// Skip malformed lines
			}
		}

		if (!header) return null;

		const stats = statSync(filePath);
		return {
			path: filePath,
			id: header.id,
			cwd: header.cwd || "",
			name,
			parentSessionPath: header.parentSession,
			created: new Date(header.timestamp),
			modified: stats.mtime,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: [firstMessage, lastMessage].filter(Boolean).join(" "),
		};
	} catch {
		return null;
	}
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(part): part is { type: "text"; text: string } =>
					part &&
					typeof part === "object" &&
					part.type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join(" ")
			.trim();
	}
	return "";
}

function findSessionFile(sessionId: string, sessionDir: string): string | null {
	if (!existsSync(sessionDir)) return null;

	try {
		const files = require("node:fs")
			.readdirSync(sessionDir)
			.filter((f: string) => f.endsWith(".jsonl"));

		for (const file of files) {
			const filePath = join(sessionDir, file);
			try {
				const content = readFileSync(filePath, "utf-8");
				const firstLine = content.split("\n")[0];
				if (!firstLine) continue;
				const header = JSON.parse(firstLine) as SessionHeader;
				if (header.type === "session" && header.id === sessionId) {
					return filePath;
				}
			} catch {}
		}
	} catch {
		// Return null on error
	}

	return null;
}

// ============================================================================
// HTTP handlers
// ============================================================================

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
	});
	res.end(JSON.stringify(data, null, 2));
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
	jsonResponse(res, 200, {
		status: "ok",
		timestamp: new Date().toISOString(),
		version: "0.80.2",
	});
}

function handleListSessions(_req: IncomingMessage, res: ServerResponse, sessionDir: string, cwd?: string): void {
	const sessions = listSessionInfos(sessionDir, cwd);
	const summary = sessions.map((s) => ({
		id: s.id,
		path: s.path,
		cwd: s.cwd,
		name: s.name,
		created: s.created.toISOString(),
		modified: s.modified.toISOString(),
		messageCount: s.messageCount,
		firstMessage: s.firstMessage,
	}));
	jsonResponse(res, 200, summary);
}

function handleGetSession(_req: IncomingMessage, res: ServerResponse, sessionId: string, sessionDir: string): void {
	const sessionFile = findSessionFile(sessionId, sessionDir);
	if (!sessionFile) {
		jsonResponse(res, 404, { error: "Session not found" });
		return;
	}

	const info = buildSessionInfoFromSync(sessionFile);
	if (!info) {
		jsonResponse(res, 404, { error: "Session not found" });
		return;
	}

	jsonResponse(res, 200, {
		id: info.id,
		path: info.path,
		cwd: info.cwd,
		name: info.name,
		parentSessionPath: info.parentSessionPath,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	});
}

function handleGetSessionMessages(
	_req: IncomingMessage,
	res: ServerResponse,
	sessionId: string,
	sessionDir: string,
	query: Record<string, string>,
): void {
	const sessionFile = findSessionFile(sessionId, sessionDir);
	if (!sessionFile) {
		jsonResponse(res, 404, { error: "Session not found" });
		return;
	}

	const entries = loadEntriesFromFile(sessionFile);
	const messages = entries
		.filter((e): e is SessionMessageEntry => e.type === "message")
		.map((e) => ({
			id: e.id,
			timestamp: e.timestamp,
			...(e.message as unknown as Record<string, unknown>),
		}));

	// Apply limit if specified
	const limit = query.limit ? parseInt(query.limit, 10) : undefined;
	const limited = limit ? messages.slice(-limit) : messages;

	jsonResponse(res, 200, limited);
}

// ============================================================================
// SSE helpers
// ============================================================================

function setupSSE(res: ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Access-Control-Allow-Origin": "*",
	});
	res.flushHeaders();
}

function writeSSEFrame(res: ServerResponse, id: number, event: string, data: unknown): void {
	res.write(`id: ${id}\n`);
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendHeartbeat(res: ServerResponse, id: number): void {
	writeSSEFrame(res, id, "heartbeat", { timestamp: new Date().toISOString() });
}

function handleSessionEventsSSE(
	req: IncomingMessage,
	res: ServerResponse,
	sessionId: string,
	sessionDir: string,
	_query: Record<string, string>,
): void {
	const sessionFile = findSessionFile(sessionId, sessionDir);
	if (!sessionFile) {
		jsonResponse(res, 404, { error: "Session not found" });
		return;
	}

	setupSSE(res);

	let frameId = 0;
	const eventsFile = sessionFile.replace(/\.jsonl$/, ".events.jsonl");

	// Replay from events file if it exists
	if (existsSync(eventsFile)) {
		try {
			const content = readFileSync(eventsFile, "utf-8");
			const lines = content.split("\n").filter((l) => l.trim());

			// Check for Last-Event-ID header
			const lastEventId = req.headers["last-event-id"];
			let startIdx = 0;
			if (lastEventId) {
				const targetId = parseInt(lastEventId as string, 10);
				startIdx = Math.max(0, lines.length - targetId - 1);
			}

			for (let i = startIdx; i < lines.length; i++) {
				frameId++;
				try {
					const event = JSON.parse(lines[i]!);
					writeSSEFrame(res, frameId, event.type || "event", event);
				} catch {
					// Skip malformed events
				}
			}
		} catch {
			// Events file not readable
		}
	}

	// Set up heartbeat
	const heartbeatInterval = setInterval(() => {
		if (res.destroyed) {
			clearInterval(heartbeatInterval);
			return;
		}
		sendHeartbeat(res, ++frameId);
	}, 5000);

	// Watch the session file for changes (polling approach)
	let lastSize = statSync(sessionFile, { throwIfNoEntry: false })?.size ?? 0;

	const pollInterval = setInterval(() => {
		if (res.destroyed) {
			clearInterval(pollInterval);
			clearInterval(heartbeatInterval);
			return;
		}

		try {
			const stats = statSync(sessionFile, { throwIfNoEntry: false });
			if (stats && stats.size > lastSize) {
				// New content appended
				const content = readFileSync(sessionFile, "utf-8");
				const lines = content.split("\n").filter((l) => l.trim());

				// Find new lines (approximate by line count)
				const prevLineCount = Math.floor(lastSize / 100); // rough estimate
				const newLines = lines.slice(prevLineCount);

				for (const line of newLines) {
					frameId++;
					try {
						const entry = JSON.parse(line);
						writeSSEFrame(res, frameId, entry.type || "entry", entry);
					} catch {
						// Skip malformed entries
					}
				}

				lastSize = stats.size;
			}
		} catch {
			// File may have been deleted
		}
	}, 1000);

	// Cleanup on disconnect
	req.on("close", () => {
		clearInterval(heartbeatInterval);
		clearInterval(pollInterval);
	});
}

function handleGlobalEventsSSE(
	req: IncomingMessage,
	res: ServerResponse,
	sessionDir: string,
	_query: Record<string, string>,
): void {
	setupSSE(res);

	let frameId = 0;

	// Set up heartbeat
	const heartbeatInterval = setInterval(() => {
		if (res.destroyed) {
			clearInterval(heartbeatInterval);
			return;
		}
		sendHeartbeat(res, ++frameId);
	}, 5000);

	// Watch the session directory for new sessions
	let lastCheck = Date.now();

	const pollInterval = setInterval(() => {
		if (res.destroyed) {
			clearInterval(pollInterval);
			clearInterval(heartbeatInterval);
			return;
		}

		try {
			const sessions = listSessionInfos(sessionDir);
			for (const session of sessions) {
				if (session.modified.getTime() > lastCheck) {
					frameId++;
					writeSSEFrame(res, frameId, "session_update", {
						id: session.id,
						path: session.path,
						name: session.name,
						modified: session.modified.toISOString(),
						messageCount: session.messageCount,
					});
				}
			}
			lastCheck = Date.now();
		} catch {
			// Directory not readable
		}
	}, 2000);

	// Cleanup on disconnect
	req.on("close", () => {
		clearInterval(heartbeatInterval);
		clearInterval(pollInterval);
	});
}

// ============================================================================
// Server
// ============================================================================

function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	sessionDir: string,
	cwd?: string,
	token?: string,
): void {
	const { pathname, query } = parseUrl(req.url || "/");

	// CORS preflight
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Access-Control-Allow-Headers": "Authorization, Last-Event-ID",
		});
		res.end();
		return;
	}

	// Only GET is supported
	if (req.method !== "GET") {
		jsonResponse(res, 405, { error: "Method not allowed" });
		return;
	}

	// Auth check — skip for /health
	if (pathname !== "/health" && !authenticateRequest(req, token)) {
		res.writeHead(401, {
			"Content-Type": "application/json",
			"WWW-Authenticate": 'Bearer realm="pi-serve"',
		});
		res.end(JSON.stringify({ error: "Unauthorized. Provide a valid Bearer token." }));
		return;
	}

	// Route matching
	if (pathname === "/health") {
		handleHealth(req, res);
		return;
	}

	if (pathname === "/sessions") {
		handleListSessions(req, res, sessionDir, cwd);
		return;
	}

	// GET /sessions/:id/events (SSE)
	const sessionEventsParams = matchRoute(pathname, "/sessions/:id/events");
	if (sessionEventsParams) {
		handleSessionEventsSSE(req, res, sessionEventsParams.id, sessionDir, query);
		return;
	}

	// GET /sessions/:id/messages
	const sessionMessagesParams = matchRoute(pathname, "/sessions/:id/messages");
	if (sessionMessagesParams) {
		handleGetSessionMessages(req, res, sessionMessagesParams.id, sessionDir, query);
		return;
	}

	// GET /sessions/:id
	const sessionParams = matchRoute(pathname, "/sessions/:id");
	if (sessionParams) {
		handleGetSession(req, res, sessionParams.id, sessionDir);
		return;
	}

	// GET /events (global SSE)
	if (pathname === "/events") {
		handleGlobalEventsSSE(req, res, sessionDir, query);
		return;
	}

	// 404
	jsonResponse(res, 404, { error: "Not found" });
}

/**
 * Start the read-only HTTP server.
 * Returns the server instance for cleanup.
 */
export function startServe(options: ServeOptions = {}): Server {
	const port = options.port ?? 3117;
	const host = options.host ?? "127.0.0.1";
	const sessionDir = options.sessionDir ?? getSessionsDir();
	const cwd: string | undefined = options.cwd;
	const token = options.token;

	if (token) {
		console.error(`pi serve: Bearer token authentication enabled`);
	}

	const server = createServer((req, res) => {
		handleRequest(req, res, sessionDir, cwd, token);
	});

	server.listen(port, host, () => {
		console.error(`pi serve listening on http://${host}:${port}`);
	});

	return server;
}

/**
 * Run serve from CLI args.
 * Parses options and starts the server.
 */
export function runServe(args: string[]): void {
	const options: ServeOptions = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--port" || arg === "-p") {
			options.port = parseInt(args[++i] ?? "", 10);
		} else if (arg === "--host") {
			options.host = args[++i];
		} else if (arg === "--session-dir") {
			options.sessionDir = args[++i];
		} else if (arg === "--cwd") {
			options.cwd = args[++i];
		} else if (arg === "--token") {
			options.token = args[++i];
		}
	}

	// Fallback to env var if --token not provided
	if (!options.token && process.env.PIKI_SERVE_TOKEN) {
		options.token = process.env.PIKI_SERVE_TOKEN;
	}

	const server = startServe(options);

	// Cleanup on signals
	const cleanup = (): void => {
		server.close(() => {
			process.exit(0);
		});
		// Force exit after 5 seconds
		setTimeout(() => process.exit(1), 5000).unref();
	};

	process.on("SIGTERM", cleanup);
	process.on("SIGINT", cleanup);
	process.on("SIGHUP", cleanup);
}
