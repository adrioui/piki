/**
 * s19 — ATIF alpha22 envelope: session_id, agent.model_name, observation
 * error disposition, and metrics.extra.cache_creation_input_tokens parity with
 * mag.
 *
 * Deterministic, no provider/tokens. Calls `exportAtifAlpha22` directly.
 */

import { describe, expect, it } from "vitest";
import { exportAtifAlpha22 } from "../../../src/core/atif.ts";
import type { SessionEntry, SessionHeader } from "../../../src/core/session-manager.ts";

const header: SessionHeader = {
	type: "session",
	version: 3,
	id: "sess-1",
	timestamp: "2026-07-04T10:00:00.000Z",
	cwd: "/home/user/project",
};

function assistant(model: string, cacheWrite: number): SessionEntry {
	return {
		type: "message",
		id: `a-${model}-${cacheWrite}`,
		parentId: null,
		timestamp: "2026-07-04T10:00:05.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			model,
			provider: "faux",
			api: "fake",
			stopReason: "stop",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 1,
				cacheWrite,
				totalTokens: 16,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		},
	};
}

function toolResult(toolCallId: string, isError: boolean): SessionEntry {
	return {
		type: "message",
		id: `t-${toolCallId}`,
		parentId: null,
		timestamp: "2026-07-04T10:00:06.000Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError,
			timestamp: Date.now(),
		},
	};
}

describe("s19 — ATIF alpha22 envelope parity", () => {
	it("F5: emits session_id from the session header and agent.model_name from entries", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-07-04T10:00:01.000Z",
				message: { role: "user", content: "hi", timestamp: Date.now() },
			},
			assistant("claude-opus-5", 0),
		];
		const doc = exportAtifAlpha22(header, entries);
		expect(doc.session_id).toBe("sess-1");
		expect(doc.agent.model_name).toBe("claude-opus-5");
	});

	it("F5: omits session_id when the header has no id", () => {
		const entries: SessionEntry[] = [assistant("m", 0)];
		const doc = exportAtifAlpha22(null, entries);
		expect(doc.session_id).toBeUndefined();
		expect(doc.agent.model_name).toBe("m");
	});

	it("F6: maps toolResult isError=true to observation result extra.error", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-07-04T10:00:01.000Z",
				message: { role: "user", content: "go", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-07-04T10:00:05.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
					model: "m",
					provider: "faux",
					api: "fake",
					stopReason: "toolUse",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
			toolResult("tc1", true),
		];
		const doc = exportAtifAlpha22(header, entries);
		const agentStep = doc.steps.find((s) => (s as { source: string }).source === "agent");
		if (!agentStep || agentStep.source !== "agent") throw new Error("agent step missing");
		expect(agentStep.observation?.results[0]?.source_call_id).toBe("tc1");
		expect(agentStep.observation?.results[0]?.extra?.error).toBe(true);
	});

	it("F6: does not add extra.error for a successful toolResult", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-07-04T10:00:01.000Z",
				message: { role: "user", content: "go", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-07-04T10:00:05.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc2", name: "read", arguments: {} }],
					model: "m",
					provider: "faux",
					api: "fake",
					stopReason: "toolUse",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
			toolResult("tc2", false),
		];
		const doc = exportAtifAlpha22(header, entries);
		const agentStep = doc.steps.find((s) => (s as { source: string }).source === "agent");
		if (!agentStep || agentStep.source !== "agent") throw new Error("agent step missing");
		expect(agentStep.observation?.results[0]?.extra).toBeUndefined();
	});

	it("F7: emits metrics.extra.cache_creation_input_tokens from usage.cacheWrite", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-07-04T10:00:01.000Z",
				message: { role: "user", content: "hi", timestamp: Date.now() },
			},
			assistant("m", 42),
		];
		const doc = exportAtifAlpha22(header, entries);
		const agentStep = doc.steps.find((s) => (s as { source: string }).source === "agent");
		if (!agentStep || agentStep.source !== "agent") throw new Error("agent step missing");
		expect(agentStep.metrics?.extra?.cache_creation_input_tokens).toBe(42);
	});

	it("F7: cache_creation_input_tokens is 0 when usage.cacheWrite is absent", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-07-04T10:00:01.000Z",
				message: { role: "user", content: "hi", timestamp: Date.now() },
			},
			assistant("m", 0),
		];
		const doc = exportAtifAlpha22(header, entries);
		const agentStep = doc.steps.find((s) => (s as { source: string }).source === "agent");
		if (!agentStep || agentStep.source !== "agent") throw new Error("agent step missing");
		expect(agentStep.metrics?.extra?.cache_creation_input_tokens).toBe(0);
	});
});
