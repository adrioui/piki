/**
 * C3 — ATIF spawnWorker step ordering parity.
 *
 * mag interleaves the `agent_created` step into the parent (root) fork's step
 * sequence at the moment of worker creation (right after the leader step that
 * issued the spawn), not appended at the very end. This file verifies piki's
 * `exportAtifAlpha22` reproduces that interleaved ordering: the synthetic
 * `spawnWorker` agent step must appear immediately after the leader
 * `spawn_worker` tool_call step that spawned the worker, and before any later
 * leader steps, with monotonic 1-based step_ids.
 */

import { describe, expect, it } from "vitest";
import { exportAtifAlpha22 } from "../src/core/atif.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() },
	};
}

function assistantText(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "test-model",
			provider: "faux",
			api: "openai-completions",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		},
	};
}

function assistantSpawn(id: string, agentId: string, taskId: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Spawning a worker." },
				{
					type: "toolCall",
					id: `tc-${agentId}`,
					name: "spawn_worker",
					arguments: { role: "scout", message: "Investigate", taskId, agentId },
				},
			],
			model: "test-model",
			provider: "faux",
			api: "openai-completions",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		},
	};
}

function spawnStepIndex(doc: ReturnType<typeof exportAtifAlpha22>): number {
	return doc.steps.findIndex(
		(s) =>
			(s as { source: string }).source === "agent" &&
			(s as { tool_calls?: Array<{ function_name: string }> }).tool_calls?.some(
				(tc) => tc.function_name === "spawnWorker",
			),
	);
}

describe("C3 — spawnWorker step ordering", () => {
	it("interleaves the spawn step right after the leader spawn_worker call, before later leader steps", () => {
		const agentId = "agent-1";
		const taskId = "task-1";
		const forkId = "fork-1";

		const leaderEntries: SessionEntry[] = [
			userEntry("u1", "Task"),
			assistantText("a1", "First response."),
			assistantSpawn("a2", agentId, taskId),
			userEntry("u2", "Continue after spawn"),
			assistantText("a3", "Final response."),
		];

		// Build a minimal fork with a user step so subagent_trajectories is populated.
		const forkSteps: SessionEntry[] = [
			{
				type: "message",
				id: "fu1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Investigate", timestamp: Date.now() },
				forkId,
			},
		];

		const doc = exportAtifAlpha22(null, leaderEntries, {
			forkEntries: new Map([[forkId, forkSteps]]),
			forkMeta: new Map([
				[
					forkId,
					{
						agentId,
						parentForkId: null,
						role: "scout",
						taskId,
						mode: "spawn",
						message: "Investigate",
					},
				],
			]),
		});

		const spawnIdx = spawnStepIndex(doc);
		expect(spawnIdx).toBeGreaterThan(0);

		// The spawn step must come immediately after the leader a2 step (which
		// carries the spawn_worker tool_call at index 2 among steps), and before
		// the later u2/a3 steps.
		const leaderStepWithSpawn = doc.steps.findIndex(
			(s) =>
				(s as { source: string }).source === "agent" &&
				(s as { tool_calls?: Array<{ function_name: string }> }).tool_calls?.some(
					(tc) => tc.function_name === "spawn_worker",
				),
		);
		expect(leaderStepWithSpawn).toBeGreaterThanOrEqual(0);
		expect(spawnIdx).toBe(leaderStepWithSpawn + 1);

		// Later leader steps remain after the spawn step.
		expect(doc.steps[spawnIdx + 1]!.source).toBe("user"); // u2
		expect(doc.steps[spawnIdx + 2]!.source).toBe("agent"); // a3

		// step_ids are monotonic 1..N.
		expect(doc.steps.map((s) => s.step_id)).toEqual(doc.steps.map((_, i) => i + 1));
	});

	it("falls back to appending at the tail when no matching spawn_worker call exists", () => {
		const agentId = "agent-orp";
		const forkId = "fork-orphan";

		const leaderEntries: SessionEntry[] = [userEntry("u1", "Task"), assistantText("a1", "Response")];
		const forkSteps: SessionEntry[] = [
			{
				type: "message",
				id: "fu1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "go", timestamp: Date.now() },
				forkId,
			},
		];

		const doc = exportAtifAlpha22(null, leaderEntries, {
			forkEntries: new Map([[forkId, forkSteps]]),
			forkMeta: new Map([
				[
					forkId,
					{
						agentId,
						parentForkId: null,
						role: "scout",
						taskId: undefined,
						mode: "spawn",
						message: undefined,
					},
				],
			]),
		});

		const spawnIdx = spawnStepIndex(doc);
		// No leader spawn_worker call matches (taskId mismatch / absent), so the
		// spawn step is appended at the tail.
		expect(spawnIdx).toBe(doc.steps.length - 1);
		expect(doc.steps.map((s) => s.step_id)).toEqual(doc.steps.map((_, i) => i + 1));
	});
});
