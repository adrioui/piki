/**
 * `pi serve` — local HTTP server with SSE.
 *
 * Routes (read + control, mirroring Magnitude alpha22 `serve`):
 *   GET  /health                       — Health check (session count)
 *   GET  /events                       — Global live event stream (SSE)
 *   GET  /sessions                     — List sessions (live + persisted)
 *   GET  /sessions/:id                 — Session detail (live state if live)
 *   GET  /sessions/:id/messages        — Session messages
 *   GET  /sessions/:id/events          — Per-session live event stream (SSE)
 *   POST /sessions                     — Create a live session (201)
 *   DELETE /sessions/:id               — Dispose a live session (204)
 *   POST /sessions/:id/messages        — Send a user message (202)
 *   POST /sessions/:id/interrupt       — Interrupt the running turn (202)
 *
 * SSE frame format:
 *   id: N
 *   event: <type>
 *   data: <json>
 *
 * Heartbeat: every 5 seconds (`: heartbeat` comment frame).
 * Last-Event-ID: replay from the in-memory event buffer where possible.
 */

import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { getSessionsDir } from "../config.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "./agent-session-services.ts";
import {
	loadEntriesFromFile,
	type SessionEntry,
	type SessionHeader,
	type SessionInfo,
	SessionManager,
	type SessionMessageEntry,
} from "./session-manager.ts";

// ============================================================================
// Types
// ============================================================================

export interface ServeOptions {
	/** Port to listen on. Default: 8080 */
	port?: number;
	/** Host to bind to. Default: "127.0.0.1" */
	host?: string;
	/** Session directory override */
	sessionDir?: string;
	/** Working directory for session lookup */
	cwd?: string;
	/** Bearer token for authentication. When set, all requests except /health must include a matching Authorization header. */
	token?: string;
	/** Enable debug logging of requests (parity with mag `serve --debug`). */
	debug?: boolean;
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
// Live session registry (control-plane state)
// ============================================================================
//
// Mirrors Magnitude alpha22's serve SessionManager: an in-memory registry of
// running AgentSessions that can be created, messaged, interrupted, disposed,
// and observed over SSE. Persisted sessions are still listed separately from
// disk so `GET /sessions` shows both live and historical sessions.

class LiveSessionRegistry {
	private sessions = new Map<string, LiveSessionRecord>();
	private globalSeq = 0;
	private globalBuffer: Array<{ sessionId: string; id: string; event: string; data: unknown }> = [];
	private globalSubscribers = new Set<
		(evt: { sessionId: string; id: string; event: string; data: unknown }) => void
	>();
	readonly cwd: string;
	readonly sessionManager: SessionManager;

	constructor(cwd: string, sessionManager: SessionManager) {
		this.cwd = cwd;
		this.sessionManager = sessionManager;
	}

	get size(): number {
		return this.sessions.size;
	}

	async createSession(opts?: {
		cwd?: string;
	}): Promise<{ id: string; title: string; status: string; createdAt: string; cwd: string }> {
		const cwd = opts?.cwd ? resolve(opts.cwd) : this.cwd;
		const sessionManager = opts?.cwd ? SessionManager.create(cwd) : this.sessionManager;
		// Build cwd-bound runtime services (auth/storage, settings, model registry,
		// resource loader) and create the session through the services path so the
		// SessionOrchestrator is attached and the session is fully wired (goal seed,
		// worker executor, etc.). Bare `createAgentSession` does not attach the
		// orchestrator, so POST /sessions/:id/messages would not function.
		const services = await createAgentSessionServices({ cwd });
		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		const id = session.sessionId;
		const record: LiveSessionRecord = {
			id,
			session,
			createdAt: new Date().toISOString(),
			cwd,
			unsubscribe: () => {},
			eventSeq: 0,
			eventBuffer: [],
			globalSeq: 0,
			liveSubscribers: new Set(),
		};
		record.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			this.pushSessionEvent(record, event.type, event);
		});
		this.sessions.set(id, record);
		return { id, title: "Session", status: "idle", createdAt: record.createdAt, cwd };
	}

	private pushSessionEvent(record: LiveSessionRecord, event: string, data: unknown): void {
		record.eventSeq++;
		const envelope = { id: String(record.eventSeq), event, data };
		record.eventBuffer.push(envelope);
		if (record.eventBuffer.length > 1000) record.eventBuffer.shift();
		for (const cb of record.liveSubscribers) cb(envelope);

		this.globalSeq++;
		const globalEnvelope = { sessionId: record.id, id: String(this.globalSeq), event, data };
		this.globalBuffer.push(globalEnvelope);
		if (this.globalBuffer.length > 1000) this.globalBuffer.shift();
		for (const sub of this.globalSubscribers) sub(globalEnvelope);
	}

	get(id: string): LiveSessionRecord | undefined {
		return this.sessions.get(id);
	}

	require(id: string): LiveSessionRecord {
		const record = this.sessions.get(id);
		if (!record) throw new SessionNotFoundError(id);
		return record;
	}

	list(): Array<{ id: string; title: string; status: string; createdAt: string; cwd: string }> {
		return [...this.sessions.values()].map((r) => ({
			id: r.id,
			title: "Session",
			status: r.session.isIdle ? "idle" : "running",
			createdAt: r.createdAt,
			cwd: r.cwd,
		}));
	}

	async delete(id: string): Promise<boolean> {
		const record = this.sessions.get(id);
		if (!record) return false;
		record.unsubscribe();
		await record.session.dispose();
		this.sessions.delete(id);
		return true;
	}

	async disposeAll(): Promise<void> {
		for (const id of [...this.sessions.keys()]) {
			await this.delete(id);
		}
	}

	subscribeSessionEvents(
		id: string,
		cb: (evt: { id: string; event: string; data: unknown }) => void,
		lastEventId?: string,
	): { replay: Array<{ id: string; event: string; data: unknown }>; unsubscribe: () => void } {
		const record = this.require(id);
		const replay = this.replayFromBuffer(record.eventBuffer, lastEventId);
		record.liveSubscribers.add(cb);
		return {
			replay,
			unsubscribe: () => {
				record.liveSubscribers.delete(cb);
			},
		};
	}

	subscribeGlobalEvents(
		cb: (evt: { sessionId: string; id: string; event: string; data: unknown }) => void,
		lastEventId?: string,
	): { replay: Array<{ sessionId: string; id: string; event: string; data: unknown }>; unsubscribe: () => void } {
		const replay = this.replayFromBuffer(this.globalBuffer, lastEventId);
		this.globalSubscribers.add(cb);
		return {
			replay,
			unsubscribe: () => {
				this.globalSubscribers.delete(cb);
			},
		};
	}

	private replayFromBuffer<T>(buffer: T[], lastEventId?: string): T[] {
		if (lastEventId == null) return [...buffer];
		const last = Number(lastEventId);
		if (!Number.isFinite(last)) return [...buffer];
		return buffer.filter((evt) => Number((evt as { id: string }).id) > last);
	}
}

interface LiveSessionRecord {
	id: string;
	session: AgentSession;
	createdAt: string;
	cwd: string;
	unsubscribe: () => void;
	eventSeq: number;
	eventBuffer: Array<{ id: string; event: string; data: unknown }>;
	globalSeq: number;
	liveSubscribers: Set<(evt: { id: string; event: string; data: unknown }) => void>;
}

class SessionNotFoundError extends Error {
	constructor(id: string) {
		super(`Session not found: ${id}`);
		this.name = "SessionNotFoundError";
	}
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
		const files = readdirSync(sessionDir)
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
		const files = readdirSync(sessionDir).filter((f: string) => f.endsWith(".jsonl"));

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

function handleHealth(
	_req: IncomingMessage,
	res: ServerResponse,
	registry: LiveSessionRegistry,
	sessionDir: string,
): void {
	const persisted = existsSync(sessionDir) ? safeReaddirCount(sessionDir) : 0;
	jsonResponse(res, 200, {
		status: "ok",
		sessions: registry.size + persisted,
	});
}

function safeReaddirCount(sessionDir: string): number {
	try {
		return readdirSync(sessionDir).filter((f: string) => f.endsWith(".jsonl")).length;
	} catch {
		return 0;
	}
}

function handleListSessions(
	_req: IncomingMessage,
	res: ServerResponse,
	sessionDir: string,
	cwd: string | undefined,
	registry: LiveSessionRegistry,
): void {
	const persisted = listSessionInfos(sessionDir, cwd);
	const liveIds = new Set(persisted.map((s) => s.id));
	const live = registry
		.list()
		.filter((s) => !liveIds.has(s.id))
		.map((s) => ({
			id: s.id,
			path: "",
			cwd: s.cwd,
			name: undefined,
			created: new Date(s.createdAt),
			modified: new Date(s.createdAt),
			messageCount: 0,
			firstMessage: "(live session)",
		}));
	const sessions = [...persisted, ...live].sort((a, b) => b.modified.getTime() - a.modified.getTime());
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

function handleGetSession(
	_req: IncomingMessage,
	res: ServerResponse,
	sessionId: string,
	sessionDir: string,
	registry: LiveSessionRegistry,
): void {
	const live = registry.get(sessionId);
	if (live) {
		jsonResponse(res, 200, {
			id: live.id,
			path: "",
			cwd: live.cwd,
			name: undefined,
			parentSessionPath: undefined,
			created: live.createdAt,
			modified: live.createdAt,
			messageCount: 0,
			firstMessage: "(live session)",
			status: live.session.isIdle ? "idle" : "running",
		});
		return;
	}

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
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Headers": "Authorization, Last-Event-ID",
	});
	res.flushHeaders();
}

function writeSSEFrame(res: ServerResponse, id: number | string, event: string, data: unknown): void {
	res.write(`id: ${id}\n`);
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendHeartbeat(res: ServerResponse): void {
	// alpha22 parity: heartbeat is a comment frame, not an "event:" frame.
	res.write(`: heartbeat\n\n`);
}

function handleSessionEventsSSE(
	req: IncomingMessage,
	res: ServerResponse,
	sessionId: string,
	sessionDir: string,
	_query: Record<string, string>,
	registry: LiveSessionRegistry,
): void {
	// Live session: stream real-time AgentSessionEvents over SSE.
	if (registry.get(sessionId)) {
		setupSSE(res);
		const lastEventId = req.headers["last-event-id"];
		const sub = registry.subscribeSessionEvents(
			sessionId,
			(evt) => {
				writeSSEFrame(res, evt.id, evt.event, evt.data);
			},
			lastEventId ? String(lastEventId) : undefined,
		);
		for (const evt of sub.replay) {
			writeSSEFrame(res, evt.id, evt.event, evt.data);
		}
		const heartbeatInterval = setInterval(() => {
			if (res.destroyed) {
				clearInterval(heartbeatInterval);
				return;
			}
			sendHeartbeat(res);
		}, 5000);
		req.on("close", () => {
			clearInterval(heartbeatInterval);
			sub.unsubscribe();
		});
		return;
	}

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
		sendHeartbeat(res);
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
	_sessionDir: string,
	_query: Record<string, string>,
	registry: LiveSessionRegistry,
): void {
	// Live global stream: real-time AgentSessionEvents across all live sessions.
	setupSSE(res);
	const lastEventId = req.headers["last-event-id"];
	const sub = registry.subscribeGlobalEvents(
		(evt) => {
			writeSSEFrame(res, evt.id, evt.event, evt.data);
		},
		lastEventId ? String(lastEventId) : undefined,
	);
	for (const evt of sub.replay) {
		writeSSEFrame(res, evt.id, evt.event, evt.data);
	}
	const heartbeatInterval = setInterval(() => {
		if (res.destroyed) {
			clearInterval(heartbeatInterval);
			return;
		}
		sendHeartbeat(res);
	}, 5000);
	req.on("close", () => {
		clearInterval(heartbeatInterval);
		sub.unsubscribe();
	});
}

// ============================================================================
// Server
// ============================================================================

function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	sessionDir: string,
	cwd: string | undefined,
	token: string | undefined,
	registry: LiveSessionRegistry,
): void {
	const { pathname, query } = parseUrl(req.url || "/");

	// CORS preflight
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID",
		});
		res.end();
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
		handleHealth(req, res, registry, sessionDir);
		return;
	}

	if (pathname === "/events" || /^\/sessions\/[^/]+\/events$/.test(pathname)) {
		if (pathname === "/events") {
			handleGlobalEventsSSE(req, res, sessionDir, query, registry);
		} else {
			const sessionEventsParams = matchRoute(pathname, "/sessions/:id/events");
			if (sessionEventsParams) {
				handleSessionEventsSSE(req, res, sessionEventsParams.id, sessionDir, query, registry);
			} else {
				jsonResponse(res, 404, { error: "Not found" });
			}
		}
		return;
	}

	if (pathname === "/sessions" || pathname.startsWith("/sessions/")) {
		handleSessionsRoute(req, res, sessionDir, cwd, registry);
		return;
	}

	// 404
	jsonResponse(res, 404, { error: "Not found" });
}

/**
 * Handle the `/sessions` route group (GET list, POST create, GET/DELETE by id,
 * POST messages, POST interrupt). Mirrors Magnitude alpha22 serve control plane.
 */
async function handleSessionsRoute(
	req: IncomingMessage,
	res: ServerResponse,
	sessionDir: string,
	cwd: string | undefined,
	registry: LiveSessionRegistry,
): Promise<void> {
	const url = req.url || "/";
	const parts = url.split("?")[0]!.split("/").filter(Boolean);

	// /sessions
	if (parts.length === 1 && parts[0] === "sessions") {
		if (req.method === "GET") {
			handleListSessions(req, res, sessionDir, cwd, registry);
			return;
		}
		if (req.method === "POST") {
			try {
				const body = await readJsonBody(req);
				const cwdArg = body?.cwd;
				if (cwdArg !== undefined && typeof cwdArg !== "string") {
					jsonResponse(res, 400, { error: "cwd must be a string" });
					return;
				}
				const created = await registry.createSession(cwdArg !== undefined ? { cwd: cwdArg } : undefined);
				jsonResponse(res, 201, created);
			} catch (error) {
				jsonResponse(res, 500, { error: error instanceof Error ? error.message : "Failed to create session" });
			}
			return;
		}
		jsonResponse(res, 405, { error: "Method not allowed" });
		return;
	}

	// /sessions/:id and /sessions/:id/<sub>
	if (parts.length >= 2 && parts[0] === "sessions") {
		const sessionId = parts[1]!;
		if (parts.length === 2) {
			if (req.method === "GET") {
				handleGetSession(req, res, sessionId, sessionDir, registry);
				return;
			}
			if (req.method === "DELETE") {
				const deleted = await registry.delete(sessionId);
				if (!deleted) {
					jsonResponse(res, 404, { error: "Session not found" });
					return;
				}
				res.writeHead(204);
				res.end();
				return;
			}
			jsonResponse(res, 405, { error: "Method not allowed" });
			return;
		}
		if (parts.length === 3 && parts[2] === "messages") {
			if (req.method === "POST") {
				try {
					const body = await readJsonBody(req);
					if (typeof body?.content !== "string") {
						jsonResponse(res, 400, { error: "Missing content string" });
						return;
					}
					if (!body.content.trim()) {
						jsonResponse(res, 400, { error: "Content cannot be empty" });
						return;
					}
					const record = registry.require(sessionId);
					await record.session.sendUserMessage(body.content);
					res.writeHead(202);
					res.end();
				} catch (error) {
					if (error instanceof SessionNotFoundError) {
						jsonResponse(res, 404, { error: "Session not found" });
						return;
					}
					jsonResponse(res, 500, { error: error instanceof Error ? error.message : "Failed to send message" });
				}
				return;
			}
			if (req.method === "GET") {
				const { query } = parseUrl(req.url || "/");
				handleGetSessionMessages(req, res, sessionId, sessionDir, query);
				return;
			}
			jsonResponse(res, 405, { error: "Method not allowed" });
			return;
		}
		if (parts.length === 3 && parts[2] === "interrupt" && req.method === "POST") {
			try {
				const record = registry.require(sessionId);
				await record.session.abort();
				res.writeHead(202);
				res.end();
			} catch (error) {
				if (error instanceof SessionNotFoundError) {
					jsonResponse(res, 404, { error: "Session not found" });
					return;
				}
				jsonResponse(res, 500, { error: error instanceof Error ? error.message : "Failed to interrupt" });
			}
			return;
		}
	}

	jsonResponse(res, 404, { error: "Not found" });
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("end", () => {
			if (!data) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(data) as Record<string, unknown>);
			} catch {
				reject(new Error("Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

/**
 * Start the HTTP/RPC serve server.
 * Returns the server instance for cleanup.
 */
export function startServe(options: ServeOptions & { cwd?: string } = {}): Server {
	const port = options.port ?? 8080;
	const host = options.host ?? "127.0.0.1";
	const sessionDir = options.sessionDir ?? getSessionsDir();
	const cwd = options.cwd ?? process.cwd();
	const token = options.token;
	const debug = options.debug === true;

	if (token) {
		console.error(`pi serve: Bearer token authentication enabled`);
	}
	if (debug) {
		console.error(`pi serve: debug logging enabled`);
	}

	const sessionManager = SessionManager.create(cwd, sessionDir);
	const registry = new LiveSessionRegistry(cwd, sessionManager);

	const server = createServer((req, res) => {
		if (debug) {
			console.error(`pi serve: ${req.method} ${req.url}`);
		}
		Promise.resolve()
			.then(() => handleRequest(req, res, sessionDir, cwd, token, registry))
			.catch((error) => {
				jsonResponse(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
			});
	});

	server.listen(port, host, () => {
		console.error(`pi serve listening on http://${host}:${port}`);
	});

	return server;
}

function printServeHelp(): void {
	console.log(
		[
			"pi serve - HTTP/RPC serve mode (Magnitude alpha22 parity)",
			"",
			"Usage: pi serve [options]",
			"",
			"Options:",
			"  --host <host>        Host to bind (default: 127.0.0.1)",
			"  -p, --port <port>    Port to listen on (default: 8080)",
			"  --token <token>      Bearer token required for non-/health requests",
			"                        (falls back to MAGNITUDE_SERVE_TOKEN, then PIKI_SERVE_TOKEN env var)",
			"  --debug              Enable request debug logging",
			"  --session-dir <dir>  Directory for session storage",
			"  --cwd <dir>          Project working directory",
			"  -h, --help           Show this help and exit",
			"",
			"Routes:",
			"  GET    /health                       Health check (session count)",
			"  GET    /sessions                     List sessions",
			"  POST   /sessions                     Create a live session",
			"  GET    /sessions/:id                 Session detail",
			"  DELETE /sessions/:id                 Dispose a live session",
			"  GET    /sessions/:id/messages        Session messages",
			"  POST   /sessions/:id/messages        Send a user message",
			"  POST   /sessions/:id/interrupt       Interrupt the running turn",
			"  GET    /sessions/:id/events          Per-session live events (SSE)",
			"  GET    /events                       Global live events (SSE)",
		].join("\n"),
	);
}

/**
 * Run serve from CLI args.
 * Parses options and starts the server.
 */
export function runServe(args: string[]): void {
	const options: ServeOptions & { cwd?: string } = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			printServeHelp();
			return;
		} else if (arg === "--port" || arg === "-p") {
			options.port = parseInt(args[++i] ?? "", 10);
		} else if (arg === "--host") {
			options.host = args[++i];
		} else if (arg === "--session-dir") {
			options.sessionDir = args[++i];
		} else if (arg === "--cwd") {
			options.cwd = args[++i];
		} else if (arg === "--token") {
			options.token = args[++i];
		} else if (arg === "--debug") {
			options.debug = true;
		}
	}

	// Fallback to env var if --token not provided.
	// Precedence: explicit CLI --token > MAGNITUDE_SERVE_TOKEN > PIKI_SERVE_TOKEN
	if (!options.token && process.env.MAGNITUDE_SERVE_TOKEN) {
		options.token = process.env.MAGNITUDE_SERVE_TOKEN;
	}
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

	// G1 (piki↔mag alpha22 parity, LOW): mag installs crash/drain lifecycle
	// handlers on the served/RPC path. serve has no dispose path, so a
	// log-only uncaughtException matches mag's crash-logging intent without
	// forcing exit; beforeExit runs tracked-child cleanup on idle drain.
	const onUncaughtException = (error: Error): void => {
		console.error("Uncaught exception in serve mode:", error?.stack ?? error?.message ?? String(error));
	};
	process.on("uncaughtException", onUncaughtException);
	const onBeforeExit = (): void => {
		killTrackedDetachedChildren();
	};
	process.on("beforeExit", onBeforeExit);
}
