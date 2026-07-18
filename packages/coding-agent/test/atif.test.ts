import type { StopReason } from "@piki/ai";
import { describe, expect, it } from "vitest";
import {
	buildAtifMetadata,
	detectAtifVersion,
	entriesToSteps,
	exportAtifAlpha22,
	exportAtifLegacy,
	exportAtifV17,
	extractEntriesFromAtif,
	extractHeaderFromAtif,
} from "../src/core/atif.ts";
import type { SessionEntry, SessionHeader } from "../src/core/session-manager.ts";

const mockHeader: SessionHeader = {
	type: "session",
	version: 3,
	id: "test-session-001",
	timestamp: "2026-07-04T10:00:00.000Z",
	cwd: "/home/user/project",
};

const mockEntries: SessionEntry[] = [
	{
		type: "message",
		id: "msg-001",
		parentId: null,
		timestamp: "2026-07-04T10:00:01.000Z",
		message: {
			role: "user",
			content: "Fix the login bug",
			timestamp: Date.now(),
		},
	},
	{
		type: "message",
		id: "msg-002",
		parentId: "msg-001",
		timestamp: "2026-07-04T10:00:05.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "I'll help you fix the login bug." }],
			model: "deepseek-v4-pro",
			provider: "commandcode",
			stopReason: "stop",
			api: "commandcode",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		},
	},
	{
		type: "model_change",
		id: "mc-001",
		parentId: "msg-002",
		timestamp: "2026-07-04T10:00:06.000Z",
		provider: "openai",
		modelId: "gpt-4o",
	},
	{
		type: "compaction",
		id: "comp-001",
		parentId: "mc-001",
		timestamp: "2026-07-04T10:01:00.000Z",
		summary: "User asked to fix login bug.",
		firstKeptEntryId: "msg-002",
		tokensBefore: 5000,
	},
	{
		type: "session_info",
		id: "si-001",
		parentId: "comp-001",
		timestamp: "2026-07-04T10:02:00.000Z",
		name: "Fix Login Bug",
	},
	{
		type: "label",
		id: "lbl-001",
		parentId: "si-001",
		timestamp: "2026-07-04T10:03:00.000Z",
		targetId: "msg-002",
		label: "first-response",
	},
];

describe("atif", () => {
	describe("entriesToSteps", () => {
		it("should convert message entries to steps", () => {
			const steps = entriesToSteps([mockEntries[0]!, mockEntries[1]!]);
			expect(steps).toHaveLength(2);
			expect(steps[0]!.type).toBe("message");
			expect(steps[0]!.role).toBe("user");
			expect(steps[0]!.content).toEqual([{ type: "text", text: "Fix the login bug" }]);
			expect(steps[1]!.role).toBe("assistant");
		});

		it("should convert compaction entries to steps with metadata", () => {
			const steps = entriesToSteps([mockEntries[3]!]);
			expect(steps[0]!.type).toBe("compaction");
			expect(steps[0]!.metadata).toEqual({
				summary: "User asked to fix login bug.",
				firstKeptEntryId: "msg-002",
				tokensBefore: 5000,
				fromHook: undefined,
			});
		});

		it("should convert model_change entries to steps with metadata", () => {
			const steps = entriesToSteps([mockEntries[2]!]);
			expect(steps[0]!.type).toBe("model_change");
			expect(steps[0]!.metadata).toEqual({
				provider: "openai",
				modelId: "gpt-4o",
			});
		});

		it("should convert session_info entries to steps with metadata", () => {
			const steps = entriesToSteps([mockEntries[4]!]);
			expect(steps[0]!.type).toBe("session_info");
			expect(steps[0]!.metadata).toEqual({ name: "Fix Login Bug" });
		});

		it("should convert label entries to steps with metadata", () => {
			const steps = entriesToSteps([mockEntries[5]!]);
			expect(steps[0]!.type).toBe("label");
			expect(steps[0]!.metadata).toEqual({
				targetId: "msg-002",
				label: "first-response",
			});
		});

		it("should preserve parent chain", () => {
			const steps = entriesToSteps(mockEntries);
			expect(steps[0]!.parentId).toBeNull();
			expect(steps[1]!.parentId).toBe("msg-001");
			expect(steps[2]!.parentId).toBe("msg-002");
		});

		it("should handle empty entries", () => {
			expect(entriesToSteps([])).toEqual([]);
		});
	});

	describe("buildAtifMetadata", () => {
		it("should build metadata from header and entries", () => {
			const meta = buildAtifMetadata(mockHeader, mockEntries);
			expect(meta.format).toBe("atif");
			expect(meta.version).toBe(1.7);
			expect(meta.createdAt).toBe("2026-07-04T10:00:00.000Z");
			expect(meta.agent).toBe("piki");
			expect(meta.cwd).toBe("/home/user/project");
			expect(meta.sessionId).toBe("test-session-001");
			expect(meta.messageCount).toBe(2);
			expect(meta.model).toBe("gpt-4o");
			expect(meta.provider).toBe("openai");
		});

		it("should extract session name from entries", () => {
			const meta = buildAtifMetadata(mockHeader, mockEntries);
			expect(meta.sessionName).toBe("Fix Login Bug");
		});

		it("should handle null header", () => {
			const meta = buildAtifMetadata(null, []);
			expect(meta.createdAt).toBeDefined();
			expect(meta.sessionId).toBeUndefined();
		});
	});

	describe("exportAtifV17", () => {
		it("should produce v1.7 trajectory", () => {
			const trajectory = exportAtifV17(mockHeader, mockEntries);
			expect(trajectory.format).toBe("atif");
			expect(trajectory.version).toBe(1.7);
			expect(trajectory.metadata).toBeDefined();
			expect(trajectory.steps).toBeDefined();
			expect(trajectory.vendor?.piki?.sessionHeader).toBe(mockHeader);
			expect(trajectory.vendor?.piki?.entries).toBe(mockEntries);
		});

		it("should have steps from entries", () => {
			const trajectory = exportAtifV17(mockHeader, mockEntries);
			expect(trajectory.steps.length).toBe(mockEntries.length);
		});
	});

	describe("exportAtifLegacy", () => {
		it("should produce v1 trajectory", () => {
			const trajectory = exportAtifLegacy(mockHeader, mockEntries);
			expect(trajectory.format).toBe("atif");
			expect(trajectory.version).toBe(1);
			expect(trajectory.session).toBe(mockHeader);
			expect(trajectory.entries).toBe(mockEntries);
		});
	});

	describe("detectAtifVersion", () => {
		it("should detect v1", () => {
			expect(detectAtifVersion({ format: "atif", version: 1 })).toBe(1);
		});

		it("should detect v1.7", () => {
			expect(detectAtifVersion({ format: "atif", version: 1.7 })).toBe(1.7);
		});

		it("should return null for non-ATIF", () => {
			expect(detectAtifVersion({ format: "json", version: 1 })).toBeNull();
		});

		it("should return null for null input", () => {
			expect(detectAtifVersion(null)).toBeNull();
		});

		it("should return null for non-object", () => {
			expect(detectAtifVersion("string")).toBeNull();
		});
	});

	describe("extractEntriesFromAtif", () => {
		it("should extract from legacy v1", () => {
			const data = exportAtifLegacy(mockHeader, mockEntries);
			expect(extractEntriesFromAtif(data)).toBe(mockEntries);
		});

		it("should extract from v1.7", () => {
			const data = exportAtifV17(mockHeader, mockEntries);
			expect(extractEntriesFromAtif(data)).toBe(mockEntries);
		});

		it("should return null for invalid data", () => {
			expect(extractEntriesFromAtif(null)).toBeNull();
			expect(extractEntriesFromAtif({ format: "json" })).toBeNull();
		});
	});

	describe("extractHeaderFromAtif", () => {
		it("should extract from legacy v1", () => {
			const data = exportAtifLegacy(mockHeader, mockEntries);
			expect(extractHeaderFromAtif(data)).toBe(mockHeader);
		});

		it("should extract from v1.7", () => {
			const data = exportAtifV17(mockHeader, mockEntries);
			expect(extractHeaderFromAtif(data)).toBe(mockHeader);
		});

		it("should return null for invalid data", () => {
			expect(extractHeaderFromAtif(null)).toBeNull();
		});
	});

	describe("roundtrip compatibility", () => {
		it("v1.7 should preserve all entries through extraction", () => {
			const trajectory = exportAtifV17(mockHeader, mockEntries);
			const extractedEntries = extractEntriesFromAtif(trajectory);
			expect(extractedEntries).toHaveLength(mockEntries.length);
			expect(extractedEntries![0]!.id).toBe("msg-001");
			expect(extractedEntries![1]!.id).toBe("msg-002");
		});

		it("legacy v1 should preserve all entries through extraction", () => {
			const trajectory = exportAtifLegacy(mockHeader, mockEntries);
			const extractedEntries = extractEntriesFromAtif(trajectory);
			expect(extractedEntries).toHaveLength(mockEntries.length);
		});
	});

	describe("exportAtifAlpha22", () => {
		const alphaEntries: SessionEntry[] = [
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
					content: [
						{ type: "thinking", thinking: "I should look at the file." },
						{ type: "text", text: "Looking into it." },
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
					],
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
			{
				type: "message",
				id: "t1",
				parentId: "a1",
				timestamp: "2026-07-04T10:00:06.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "line1" }],
					isError: false,
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				id: "a2",
				parentId: "t1",
				timestamp: "2026-07-04T10:00:09.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done." }],
					model: "deepseek-v4-pro",
					provider: "commandcode",
					api: "commandcode",
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
			},
		];

		it("always sets trajectory_id to 'main'", () => {
			const doc = exportAtifAlpha22(mockHeader, alphaEntries);
			expect(doc.trajectory_id).toBe("main");
		});

		it("emits non-null session header via schema_version/agent", () => {
			const doc = exportAtifAlpha22(mockHeader, alphaEntries);
			expect(doc.schema_version).toBe("ATIF-v1.7");
			expect(doc.agent.name).toBe("piki");
			expect(doc.subagent_trajectories).toEqual([]);
		});

		it("uses numeric, monotonic 1-based step_ids decoupled from tool results", () => {
			const doc = exportAtifAlpha22(mockHeader, alphaEntries);
			// user(1) + assistant(2, consumes 1 toolResult) + assistant(3)
			expect(doc.steps.map((s) => s.step_id)).toEqual([1, 2, 3]);
		});

		it("separates reasoning_content from message text and keeps raw model name", () => {
			const doc = exportAtifAlpha22(mockHeader, alphaEntries);
			const agentStep = doc.steps[1]!;
			expect(agentStep.source).toBe("agent");
			if (agentStep.source !== "agent") return;
			expect(agentStep.model_name).toBe("deepseek-v4-pro");
			expect(agentStep.message).toBe("Looking into it.");
			expect(agentStep.reasoning_content).toBe("I should look at the file.");
			expect(agentStep.tool_calls).toEqual([
				{ tool_call_id: "tc1", function_name: "read", arguments: { path: "a.ts" }, extra: { cached: false } },
			]);
			expect(agentStep.observation).toEqual({
				results: [{ source_call_id: "tc1", content: "line1" }],
			});
		});

		it("S28: trims message and reasoning_content whitespace and normalizes extra.outcome", () => {
			const build = (stopReason: StopReason): SessionEntry[] => [
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
					parentId: "u1",
					timestamp: "2026-07-04T10:00:05.000Z",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "  inner reasoning  \n" },
							{ type: "text", text: "  leading and trailing  " },
						],
						model: "deepseek-v4-pro",
						provider: "commandcode",
						api: "commandcode",
						stopReason,
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
				},
			];

			// Trimmed whitespace in message/reasoning_content (D7/D8).
			const doc = exportAtifAlpha22(mockHeader, build("stop"));
			const step = doc.steps[1]!;
			expect(step.source).toBe("agent");
			if (step.source !== "agent") return;
			expect(step.message).toBe("leading and trailing");
			expect(step.reasoning_content).toBe("inner reasoning");

			// extra.outcome normalized to mag's alpha22 outcome tag vocabulary
			// (mapFinishReasonToOutcome): stop/toolUse -> Completed, length ->
			// OutputTruncated, contentFiltered -> ContentFiltered.
			const cases: Array<[StopReason, string]> = [
				["stop", "Completed"],
				["toolUse", "Completed"],
				["length", "OutputTruncated"],
				["contentFiltered", "ContentFiltered"],
			];
			for (const [stopReason, expected] of cases) {
				const d = exportAtifAlpha22(mockHeader, build(stopReason));
				const s = d.steps[1]!;
				expect(s.source).toBe("agent");
				if (s.source !== "agent") continue;
				expect(s.extra.outcome).toBe(expected);
			}
		});

		it("S7: failed empty assistant call yields llm_call_count 0, successful empty yields 1", () => {
			const failedEmpty: SessionEntry[] = [
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
					parentId: "u1",
					timestamp: "2026-07-04T10:00:05.000Z",
					message: {
						role: "assistant",
						content: [],
						model: "deepseek-v4-pro",
						provider: "commandcode",
						api: "commandcode",
						stopReason: "error",
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
					llmFailed: true,
				},
			];
			const docFailed = exportAtifAlpha22(mockHeader, failedEmpty);
			const failedStep = docFailed.steps[1];
			expect(failedStep.source).toBe("agent");
			if (failedStep.source !== "agent") return;
			expect(failedStep.llm_call_count).toBe(0);

			// Successful empty turn (no llmFailed, no text) is still counted as 1.
			const emptyNoFlag = JSON.parse(JSON.stringify(failedEmpty)) as SessionEntry[];
			(emptyNoFlag[1] as { llmFailed?: boolean }).llmFailed = false;
			(emptyNoFlag[1] as { message: { stopReason: string } }).message.stopReason = "stop";
			const docOk = exportAtifAlpha22(mockHeader, emptyNoFlag);
			const okStep = docOk.steps[1];
			expect(okStep.source).toBe("agent");
			if (okStep.source !== "agent") return;
			expect(okStep.llm_call_count).toBe(1);
		});

		it("S8: forkId flows into extra.forkId for both user and assistant steps", () => {
			const leaderEntries: SessionEntry[] = [
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
					parentId: "u1",
					timestamp: "2026-07-04T10:00:05.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						model: "deepseek-v4-pro",
						provider: "commandcode",
						api: "commandcode",
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
				},
			];
			const doc = exportAtifAlpha22(mockHeader, leaderEntries);
			expect(doc.steps[0]!.extra.forkId).toBeNull();
			expect(doc.steps[1]!.extra.forkId).toBeNull();
		});
	});

	describe("exportAtifAlpha22 with fork entries (S5/S8)", () => {
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "fu1",
				parentId: null,
				timestamp: "2026-07-04T11:00:01.000Z",
				message: { role: "user", content: "Investigate the widget", timestamp: Date.now() },
				forkId: "fork-1",
			},
			{
				type: "message",
				id: "fa1",
				parentId: "fu1",
				timestamp: "2026-07-04T11:00:05.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Checking." },
						{ type: "toolCall", id: "ftc1", name: "read", arguments: { path: "w.ts" } },
					],
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
				forkId: "fork-1",
			},
			{
				type: "message",
				id: "ft1",
				parentId: "fa1",
				timestamp: "2026-07-04T11:00:06.000Z",
				message: {
					role: "toolResult",
					toolCallId: "ftc1",
					toolName: "read",
					content: [{ type: "text", text: "widget ok" }],
					isError: false,
					timestamp: Date.now(),
				},
				forkId: "fork-1",
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

		it("populates subagent_trajectories with one trajectory per fork, user-first", () => {
			const doc = exportAtifAlpha22(mockHeader, leaderEntries, {
				forkEntries: new Map([["fork-1", forkEntries]]),
			});
			expect(doc.subagent_trajectories).toHaveLength(1);
			const traj = doc.subagent_trajectories[0] as {
				trajectory_id: string;
				steps: Array<{ source: string; extra: { forkId: string | null } }>;
				final_metrics?: { total_steps: number };
			};
			expect(traj.trajectory_id).toBe("fork-1");
			expect(traj.steps[0]!.source).toBe("user");
			expect(traj.steps[0]!.extra.forkId).toBe("fork-1");
			// assistant step also carries its forkId
			const faStep = traj.steps.find((s) => s.source === "agent");
			expect(faStep?.extra.forkId).toBe("fork-1");
			// leader step stays null
			expect(doc.steps[0]!.extra.forkId).toBeNull();
			expect(doc.steps[1]!.extra.forkId).toBeNull();
			// fork metrics present (user + assistant + toolResult = 3 steps by alpha22 count)
			expect(traj.final_metrics?.total_steps).toBeGreaterThan(0);
		});

		it("accumulates fork step count into root final_metrics", () => {
			const doc = exportAtifAlpha22(mockHeader, leaderEntries, {
				forkEntries: new Map([["fork-1", forkEntries]]),
			});
			// alpha22 counts ALL steps (user, assistant, toolResult).
			// leader: user + assistant = 2. fork: user + assistant + toolResult = 3. Total = 5.
			expect(doc.final_metrics.total_steps).toBe(5);
		});

		it("keeps empty subagent_trajectories when no forkEntries passed (backward compat)", () => {
			const doc = exportAtifAlpha22(mockHeader, leaderEntries);
			expect(doc.subagent_trajectories).toEqual([]);
		});
	});

	describe("exportAtifAlpha22 system/event steps (B: llm_call_count)", () => {
		const systemEntries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-07-04T10:00:01.000Z",
				message: { role: "user", content: "go", timestamp: Date.now() },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp: "2026-07-04T10:00:02.000Z",
				summary: "compacted",
				firstKeptEntryId: "u1",
				tokensBefore: 100,
			},
			{
				type: "branch_summary",
				id: "b1",
				parentId: "c1",
				timestamp: "2026-07-04T10:00:03.000Z",
				fromId: "u1",
				summary: "branch",
			},
			{
				type: "custom",
				id: "cu1",
				parentId: "b1",
				timestamp: "2026-07-04T10:00:04.000Z",
				customType: "note",
				data: { k: 1 },
			},
			{
				type: "model_change",
				id: "m1",
				parentId: "cu1",
				timestamp: "2026-07-04T10:00:05.000Z",
				provider: "openai",
				modelId: "gpt-4o",
			},
			{
				type: "thinking_level_change",
				id: "t1",
				parentId: "m1",
				timestamp: "2026-07-04T10:00:06.000Z",
				thinkingLevel: "high",
			},
			{
				type: "session_info",
				id: "s1",
				parentId: "t1",
				timestamp: "2026-07-04T10:00:07.000Z",
				name: "Session",
			},
			{
				type: "label",
				id: "l1",
				parentId: "s1",
				timestamp: "2026-07-04T10:00:08.000Z",
				targetId: "u1",
				label: "first",
			},
		];

		it("emits llm_call_count: 0 on every non-message (system/event) step", () => {
			const doc = exportAtifAlpha22(mockHeader, systemEntries);
			// user step is index 0; all subsequent steps are system/event steps.
			expect(doc.steps[0]!.source).toBe("user");
			for (let i = 1; i < doc.steps.length; i++) {
				const step = doc.steps[i]!;
				expect(step.source).toBe("system");
				expect((step as { llm_call_count?: number }).llm_call_count).toBe(0);
			}
		});

		it("does not add llm_call_count to user steps (only system/event)", () => {
			const doc = exportAtifAlpha22(mockHeader, systemEntries);
			expect((doc.steps[0] as { llm_call_count?: number }).llm_call_count).toBeUndefined();
		});
	});
});

describe("exportAtifAlpha22 interrupt step (F-ATIF / S8)", () => {
	// mag alpha22 `interruptToStep` emits a `source:"user"` step with
	// `extra:{forkId, allKilled}` and message "All agents interrupted" when
	// allKilled, else "Agent interrupted". piki records this via InterruptEntry.
	const interruptEntries = (allKilled: boolean): SessionEntry[] => [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-07-04T10:00:01.000Z",
			message: { role: "user", content: "go", timestamp: Date.now() },
		},
		{
			type: "interrupt",
			id: "i1",
			parentId: "u1",
			timestamp: "2026-07-04T10:00:02.000Z",
			forkId: "root-fork",
			allKilled,
			message: allKilled ? "All agents interrupted" : "Agent interrupted",
		},
	];

	it("maps an InterruptEntry to a source:user step with forkId/allKilled extra", () => {
		const doc = exportAtifAlpha22(mockHeader, interruptEntries(false));
		const step = doc.steps.find((s) => (s as { extra?: { forkId?: unknown } }).extra?.forkId === "root-fork");
		expect(step).toBeDefined();
		expect(step!.source).toBe("user");
		expect(step!.message).toBe("Agent interrupted");
		expect((step as { llm_call_count: number }).llm_call_count).toBe(0);
		expect((step as { extra: { forkId: string | null; allKilled: boolean } }).extra).toEqual({
			forkId: "root-fork",
			allKilled: false,
		});
	});

	it("uses 'All agents interrupted' and allKilled:true when the interrupt killed everything", () => {
		const doc = exportAtifAlpha22(mockHeader, interruptEntries(true));
		const step = doc.steps.find((s) => (s as { extra?: { allKilled?: unknown } }).extra?.allKilled === true);
		expect(step).toBeDefined();
		expect(step!.message).toBe("All agents interrupted");
		expect((step as { extra: { forkId: string | null; allKilled: boolean } }).extra.allKilled).toBe(true);
	});

	it("counts the interrupt step in total_steps (every entry is one step)", () => {
		const doc = exportAtifAlpha22(mockHeader, interruptEntries(false));
		// 1 user message + 1 interrupt entry = 2 steps total.
		expect(doc.final_metrics.total_steps).toBe(2);
	});
});
