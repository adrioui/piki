import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServe } from "../src/core/serve.ts";

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), `piki-serve-test-`));
}

function createTestSession(dir: string, id: string): string {
	const sessionDir = join(dir, "sessions");
	mkdirSync(sessionDir, { recursive: true });

	const sessionFile = join(sessionDir, `${id}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: new Date().toISOString(),
		cwd: "/test/project",
	};
	const userMsg = {
		type: "message",
		id: "msg-001",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "Hello world", timestamp: Date.now() },
	};
	const assistantMsg = {
		type: "message",
		id: "msg-002",
		parentId: "msg-001",
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Hi there!" }],
			model: "test-model",
			provider: "test-provider",
			stopReason: "end_turn",
		},
	};

	writeFileSync(sessionFile, `${[header, userMsg, assistantMsg].map((e) => JSON.stringify(e)).join("\n")}\n`);
	return sessionFile;
}

function fetchJSON(url: string): Promise<{ status: number; data: unknown }> {
	return new Promise((resolve, reject) => {
		import("node:http").then(({ get }) => {
			get(url, (res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) });
					} catch {
						resolve({ status: res.statusCode ?? 0, data: body });
					}
				});
			}).on("error", reject);
		});
	});
}

function fetchSSE(url: string, timeoutMs = 2000): Promise<{ frames: string[] }> {
	return new Promise((resolve) => {
		const frames: string[] = [];
		import("node:http").then(({ get }) => {
			get(url, (res) => {
				let buffer = "";
				res.on("data", (chunk) => {
					buffer += chunk.toString();
					const parts = buffer.split("\n\n");
					buffer = parts.pop() ?? "";
					frames.push(...parts.filter((f) => f.trim()));
				});
				setTimeout(() => {
					res.destroy();
					resolve({ frames });
				}, timeoutMs);
			});
		});
	});
}

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("serve", () => {
	let server: ReturnType<typeof startServe>;
	let port: number;
	let tempDir: string;
	let sessionDir: string;
	let sessionId: string;

	beforeAll(async () => {
		tempDir = createTempDir();
		tempDirs.push(tempDir);
		sessionDir = join(tempDir, "sessions");
		sessionId = "test-session-001";
		createTestSession(tempDir, sessionId);

		// Use random port
		port = 30000 + Math.floor(Math.random() * 10000);
		server = startServe({ port, host: "127.0.0.1", sessionDir });

		// Wait for server to start
		await new Promise<void>((resolve) => {
			server.on("listening", resolve);
		});
	});

	afterAll(async () => {
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	describe("GET /health", () => {
		it("returns health status", async () => {
			const result = await fetchJSON(`http://127.0.0.1:${port}/health`);
			expect(result.status).toBe(200);
			const data = result.data as { status: string; sessions: number };
			expect(data.status).toBe("ok");
			expect(data.sessions).toBeDefined();
			expect(typeof data.sessions).toBe("number");
		});
	});

	describe("GET /sessions", () => {
		it("returns list of sessions", async () => {
			const result = await fetchJSON(`http://127.0.0.1:${port}/sessions`);
			expect(result.status).toBe(200);
			const data = result.data as Array<{ id: string; messageCount: number }>;
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThanOrEqual(1);
			expect(data.some((s) => s.id === sessionId)).toBe(true);
		});
	});

	describe("GET /sessions/:id", () => {
		it("returns session metadata", async () => {
			const result = await fetchJSON(`http://127.0.0.1:${port}/sessions/${sessionId}`);
			expect(result.status).toBe(200);
			const data = result.data as { id: string; messageCount: number; cwd: string };
			expect(data.id).toBe(sessionId);
			expect(data.messageCount).toBe(2);
			expect(data.cwd).toBe("/test/project");
		});

		it("returns 404 for unknown session", async () => {
			const result = await fetchJSON(`http://127.0.0.1:${port}/sessions/unknown-id`);
			expect(result.status).toBe(404);
		});
	});

	describe("GET /sessions/:id/messages", () => {
		it("returns session messages", async () => {
			const result = await fetchJSON(`http://127.0.0.1:${port}/sessions/${sessionId}/messages`);
			expect(result.status).toBe(200);
			const data = result.data as Array<{ role: string; content: unknown }>;
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBe(2);
			expect(data[0].role).toBe("user");
			expect(data[1].role).toBe("assistant");
		});

		it("supports limit parameter", async () => {
			const result = await fetchJSON(`http://127.0.0.1:${port}/sessions/${sessionId}/messages?limit=1`);
			expect(result.status).toBe(200);
			const data = result.data as Array<{ role: string }>;
			expect(data.length).toBe(1);
		});
	});

	describe("GET /sessions/:id/events", () => {
		it("returns SSE stream with heartbeat", async () => {
			const { frames } = await fetchSSE(`http://127.0.0.1:${port}/sessions/${sessionId}/events`, 6000);
			// Should have at least a heartbeat frame (interval is 5 seconds)
			expect(frames.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("GET /events", () => {
		it("returns SSE stream with heartbeat", async () => {
			const { frames } = await fetchSSE(`http://127.0.0.1:${port}/events`, 6000);
			// Should have at least a heartbeat frame (interval is 5 seconds)
			expect(frames.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("404 for unknown routes", () => {
		it("returns 404 for unknown path", async () => {
			const result = await fetchJSON(`http://127.0.0.1:${port}/unknown`);
			expect(result.status).toBe(404);
		});
	});

	describe("CORS", () => {
		it("allows CORS for GET requests", async () => {
			const result = await fetchJSON(`http://127.0.0.1:${port}/health`);
			expect(result.status).toBe(200);
		});
	});
});
