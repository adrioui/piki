import { describe, expect, it } from "vitest";
import { exportAtifAlpha22 } from "../../../src/core/atif.ts";
import type { SessionEntry, SessionHeader } from "../../../src/core/session-manager.ts";

const mockHeader: SessionHeader = {
	type: "session",
	version: 3,
	id: "test-session-001",
	timestamp: "2026-07-04T10:00:00.000Z",
	cwd: "/home/user/project",
};

const forkId = "fork-abc-123";
const realAgentId = "agent-real-xyz-789";
const parentForkId = "test-session-001";
const taskId = "task-widget-42";
const role = "tool";
const mode = "spawn";
const message = "Investigate the widget";

const forkEntries: SessionEntry[] = [
	{
		type: "message",
		id: "fu1",
		parentId: null,
		timestamp: "2026-07-04T11:00:01.000Z",
		message: { role: "user", content: "Investigate the widget", timestamp: Date.now() },
		forkId,
	},
	{
		type: "message",
		id: "fa1",
		parentId: "fu1",
		timestamp: "2026-07-04T11:00:05.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Checking." }],
			model: "deepseek-v4-pro",
			provider: "commandcode",
			api: "commandcode",
			stopReason: "stop",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		},
		forkId,
	},
];

const leaderEntries: SessionEntry[] = [
	{
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: "2026-07-04T10:00:01.000Z",
		message: { role: "user", content: "Fix the bug", timestamp: Date.now() },
	},
	{
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: "2026-07-04T10:00:05.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Delegating." }],
			model: "deepseek-v4-pro",
			provider: "commandcode",
			api: "commandcode",
			stopReason: "stop",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		},
	},
];

interface ForkMeta {
	agentId: string;
	parentForkId: string | null;
	role: string;
	taskId: string | undefined;
	mode: string;
	message: string | undefined;
}

describe("s13 atif fork meta (A)", () => {
	it("uses the real agentId (not spawnWorker-<forkId>) in spawn step tool_call_id and trajectory ref", () => {
		const forkMeta = new Map<string, ForkMeta>([
			[
				forkId,
				{
					agentId: realAgentId,
					parentForkId,
					role,
					taskId,
					mode,
					message,
				},
			],
		]);

		const doc = exportAtifAlpha22(mockHeader, leaderEntries, {
			forkEntries: new Map([[forkId, forkEntries]]),
			forkMeta,
		});

		const agentSteps = doc.steps.filter((s) => s.source === "agent");
		const spawnStep = agentSteps[agentSteps.length - 1]!;
		expect(spawnStep.source).toBe("agent");

		expect(spawnStep.tool_calls).toBeDefined();
		const toolCall = spawnStep.tool_calls![0]!;
		expect(toolCall.tool_call_id).toBe(realAgentId);
		expect(toolCall.tool_call_id).not.toBe(`spawnWorker-${forkId}`);

		expect(toolCall.function_name).toBe("spawnWorker");
		expect(toolCall.arguments).toEqual({
			role,
			taskId,
			mode,
			message,
		});

		const result = spawnStep.observation!.results[0]!;
		expect(result.source_call_id).toBe(realAgentId);
		expect(result.subagent_trajectory_ref![0]!.trajectory_id).toBe(realAgentId);

		expect(spawnStep.extra).toEqual({
			agentId: realAgentId,
			forkId,
			parentForkId,
			taskId,
		});

		expect(doc.subagent_trajectories).toHaveLength(1);
		const traj = doc.subagent_trajectories[0] as {
			trajectory_id: string;
			steps: Array<{ source: string; extra: { forkId: string | null } }>;
		};
		expect(traj.trajectory_id).toBe(forkId);
		expect(traj.steps[0]!.source).toBe("user");
		expect(traj.steps[0]!.extra.forkId).toBe(forkId);
	});

	it("falls back to forkId when a fork has no recorded metadata", () => {
		const doc = exportAtifAlpha22(mockHeader, leaderEntries, {
			forkEntries: new Map([[forkId, forkEntries]]),
		});
		const agentSteps = doc.steps.filter((s) => s.source === "agent");
		const spawnStep = agentSteps[agentSteps.length - 1]!;
		const toolCall = spawnStep.tool_calls![0]!;
		expect(toolCall.tool_call_id).toBe(forkId);
		expect(spawnStep.extra.agentId).toBe(forkId);
		expect(spawnStep.extra.parentForkId).toBeNull();
		expect(toolCall.arguments).toEqual({ role: "worker", taskId: forkId, mode: "spawn" });
	});
});
