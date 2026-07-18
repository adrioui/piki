import type { AssistantMessage } from "@piki/ai";
import { Type } from "typebox";
import type { SessionEntry } from "../../../../src/core/session-manager.ts";
import { WorkerSession } from "../../../../src/core/worker-session.ts";
import type { ParityFixture } from "./types.ts";

const FORK_ID = "fork-scout-1";

function workerModel() {
	return {
		id: "test-model",
		name: "Test",
		api: "openai-completions",
		provider: "faux",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "faux",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * Exercises ATIF S5/S7/S8 against the REAL `WorkerSession` fork-entry capture
 * path (no leader runtime plumbing — deterministic by design).
 *
 * The worker:
 *  1. emits its initial user/task step (constructor) with forkId + null parent. (S5)
 *  2. emits an assistant step with a `read` tool call. (S5 ordering + S8 forkId)
 *  3. emits the `read` tool-result step.
 *
 * The only LLM call is a successful (non-empty-text) assistant turn, so
 * `llm_call_count` must be `1` (S7: successful-empty = 1, failed-empty = 0).
 */
export async function buildForkEntries(): Promise<Map<string, SessionEntry[]>> {
	const captured: SessionEntry[] = [];
	const session = new WorkerSession({
		forkId: FORK_ID,
		agentId: "agent-scout-1",
		role: "scout",
		model: workerModel(),
		systemPrompt: "You are a scout.",
		initialMessage: "Read the widget source.",
		tools: [
			{
				name: "read",
				description: "Read files",
				parameters: Type.Object({ path: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "file contents" }], details: null }),
			},
		],
		contextLimit: 128000,
		onFinished: () => {},
		onError: () => {},
		onForkEntry: (entry) => captured.push(entry),
	});

	const internals = session as unknown as {
		handleAgentEvent(event: { type: string; message: AssistantMessage }, signal: AbortSignal): Promise<void>;
	};
	const signal = new AbortController().signal;

	const assistant = assistantMessage(
		[
			{ type: "text", text: "Reading the widget." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "widget.ts" } },
		],
		"toolUse",
	);
	await internals.handleAgentEvent({ type: "message_end", message: assistant }, signal);

	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "line1" }],
		isError: false,
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
	await internals.handleAgentEvent({ type: "message_end", message: toolResult }, signal);

	session.kill();

	const map = new Map<string, SessionEntry[]>();
	map.set(FORK_ID, captured);
	return map;
}

export const forkScenarioFixture: ParityFixture = {
	id: "fork-scenario",
	description: "leader spawns worker (spawn_worker); worker read captured via fork entries (S5/S7/S8)",
	prompt: "Investigate the widget by spawning a scout worker.",
	toolNames: ["spawn_worker", "read"],
	// Not replayed through the leader harness; fork entries built directly via
	// buildForkEntries, so this is intentionally an empty (unused) script.
	responses: [],
	expectedPermissions: [{ tool: { name: "read", args: { path: "widget.ts" } }, permitted: true }],
	expectedAtif: {
		subagentTrajectoryCount: 1,
		forkIdPresent: true,
		llmCallCountPresent: true,
		// initial user + assistant(read) + toolResult = 3 message entries
		totalSteps: 3,
		hasAssistantWithToolCalls: true,
	},
	buildForkEntries,
};
