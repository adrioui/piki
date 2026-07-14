// packages/agent/src/projections/window-projection.ts
//
// WindowProjection builds the per-fork timeline ("window") surfaced to the UI:
// an ordered list of timeline entries plus running token accounting
// (messageTokens, systemPromptTokens, tokenEstimate).
//
// It is a forked projection (one window per fork, plus the root fork) driven by
// the fork lifecycle (session_initialized, agent_created, turn_started/
// turn_outcome, message_start/chunk/end, observations_captured, goal_started,
// skill_activated, user_bash_command, interrupt, observer_outcome), global
// handlers (shell_process_exited, agent_task_changed, agent_created,
// observer_outcome), and signals for agent became-idle, subagent-user-killed,
// and resolved user messages.
//
// Scope note: the window currently consumes AgentStatus, Compaction, Goal, and
// UserMessageResolution. Additional projection/signal reads (task graph, harness
// state, outbound messages, worker activity, detached process, compaction
// injection) are added as those subsystems are introduced; those handlers are
// omitted here on purpose. Token accounting uses piki-local content/token
// helpers operating on the timeline-entry shapes.

import { defineForkedProjection, type ProjectionRef } from "@piki/event-core";
import { type AgentInfo, AgentStatusProjection, type AgentStatusState } from "./agent-status.ts";
import { CompactionProjection } from "./compaction.ts";
import { GoalProjection } from "./goal.ts";
import { UserMessageResolutionProjection } from "./user-message-resolution.ts";

// ─── Local timeline/entry types (structural match for the renderer) ──────────

export type ContentPart = { _tag: "TextPart"; text: string };

export type WindowAgentAtom =
	| { kind: "thought"; text: string }
	| { kind: "tool_call"; toolName: string; attributes: Record<string, string>; body: string }
	| { kind: "message"; direction: "to_lead" | "from_user" | "from_lead"; text: string }
	| { kind: "error"; message: string }
	| { kind: "idle" };

export type WindowTimelineEntry =
	| { kind: "turn_start"; timestamp: number }
	| { kind: "turn_end" }
	| { kind: "goal_context"; objective: string; title?: string }
	| { kind: "session_context"; content: ContentPart[] }
	| { kind: "fork_context"; content: ContentPart[] }
	| { kind: "observer_turn"; observerTurnId: string; justification?: unknown; escalate: boolean; reasoning?: unknown }
	| { kind: "assistant_turn"; turnId: string; feedback: ReadonlyArray<FeedbackEntry>; clean: boolean }
	| { kind: "user_message"; timestamp: number; text: string; synthetic?: boolean; attachments?: unknown[] }
	| { kind: "observation"; timestamp: number; parts: ReadonlyArray<ContentPart> }
	| { kind: "agent_block"; timestamp: number; agentId: string; role: string; atoms: ReadonlyArray<WindowAgentAtom> }
	| { kind: "coordinator_message"; timestamp: number; text: string }
	| {
			kind: "user_bash_command";
			timestamp: number;
			cwd: string;
			exitCode: number;
			command: string;
			stdout: string;
			stderr: string;
	  }
	| { kind: "user_to_agent"; timestamp: number; agentId: string; text: string }
	| { kind: "worker_user_killed"; timestamp: number; agentId: string; agentType: string }
	| {
			kind: "detached_process_exited";
			timestamp: number;
			pid: number;
			command: string;
			exitCode: number;
			stdoutPath: string;
			stderrPath: string;
	  }
	| { kind: "escalation"; timestamp: number; observedForkId: string | null; justification?: unknown }
	| {
			kind: "task_update";
			action: string;
			taskId: string;
			title?: string;
			previousStatus?: string;
			nextStatus?: string;
	  }
	| { kind: "task_reassigned" };

export type FeedbackEntry =
	| { kind: "message_ack"; destination: string; chars: number }
	| { kind: "error"; message: string }
	| { kind: "overthinking"; message: string }
	| { kind: "interrupted" };

// ─── Window fork state ──────────────────────────────────────────────────────

export interface WindowForkState {
	readonly messages: ReadonlyArray<WindowTimelineEntry>;
	readonly queuedTimeline: ReadonlyArray<unknown>;
	readonly currentTurnId: string | null;
	readonly currentChainId: string | null;
	readonly nextQueueSeq: number;
	readonly _activeMessageIsCoordinator: boolean;
	readonly _coordinatorChars: number;
	readonly tokenEstimate: number;
	readonly messageTokens: number;
	readonly systemPromptTokens: number;
	readonly lastAnchoredTotal: number | null;
	readonly lastAnchoredMessageTokens: number | null;
	readonly autopilotEnabled: boolean;
	readonly consumerAutopilotKnowledge: { advisor: unknown; leader: unknown };
}

const initialFork: WindowForkState = {
	messages: [],
	queuedTimeline: [],
	currentTurnId: null,
	currentChainId: null,
	nextQueueSeq: 0,
	_activeMessageIsCoordinator: false,
	_coordinatorChars: 0,
	tokenEstimate: 0,
	messageTokens: 0,
	systemPromptTokens: 0,
	lastAnchoredTotal: null,
	lastAnchoredMessageTokens: null,
	autopilotEnabled: false,
	consumerAutopilotKnowledge: { advisor: null, leader: null },
};

// ─── Local token/content helpers ─────────────────────────────────────────────

/** Build a text content part. */
function textParts(text: string): ContentPart[] {
	return [{ _tag: "TextPart", text }];
}

/** Recompute the running token estimate from the (optional) anchored totals. */
function computeTokenEstimate(fork: WindowForkState, messageTokens: number): number {
	if (fork.lastAnchoredTotal !== null) return fork.lastAnchoredTotal;
	return fork.systemPromptTokens + messageTokens;
}

/** Append a timeline entry and recompute message/token accounting. */
function appendTimeline(
	fork: WindowForkState,
	entry: WindowTimelineEntry,
	estimatedTokens: number,
): { fork: WindowForkState; messageTokens: number } {
	const messages = [...fork.messages, entry];
	const messageTokens = fork.messageTokens + estimatedTokens;
	return { fork: { ...fork, messages }, messageTokens };
}

/** Enqueue a timeline entry into the fork's message list. */
function enqueueTimeline(fork: WindowForkState, entry: WindowTimelineEntry, estimatedTokens: number): WindowForkState {
	const { fork: nextFork, messageTokens } = appendTimeline(fork, entry, estimatedTokens);
	const tokenEstimate = computeTokenEstimate(nextFork, messageTokens);
	return { ...nextFork, messageTokens, tokenEstimate };
}

// ─── Agent lookup (cross-projection read) ──────────────────────────────────

function getAgentByForkId(state: AgentStatusState, forkId: string): AgentInfo | undefined {
	const agentId = state.agentByForkId.get(forkId);
	if (!agentId) return undefined;
	return state.agents.get(agentId);
}

function readAgentStatus(read: (projection: ProjectionRef) => unknown): AgentStatusState | undefined {
	const value = read(AgentStatusProjection);
	return value === undefined ? undefined : (value as AgentStatusState);
}

// ─── Projection factory ────────────────────────────────────────────────────

export const WindowProjection = defineForkedProjection()({
	name: "Window",
	// Reads the projections the window currently surfaces. Additional
	// projections are added as their subsystems come online.
	reads: [AgentStatusProjection, CompactionProjection, GoalProjection, UserMessageResolutionProjection],
	signals: {
		tokenEstimateChanged: { name: "Window/tokenEstimateChanged" },
	},
	initialFork,
	eventHandlers: {
		autopilot_toggled: ({ fork }) => fork,
		session_initialized: ({ fork, emit }) => {
			const sessionMsg: WindowTimelineEntry = {
				kind: "session_context",
				content: textParts(""),
			};
			const entryTokens = 0;
			const messageTokens = fork.messageTokens + entryTokens;
			const tokenEstimate = fork.systemPromptTokens + messageTokens;
			const result: WindowForkState = {
				...fork,
				messages: [sessionMsg, ...fork.messages],
				messageTokens,
				tokenEstimate,
			};
			emitIfChanged(fork, result, emit);
			return result;
		},
		goal_started: ({ fork, event, emit }) => {
			const entry: WindowTimelineEntry = {
				kind: "goal_context",
				objective: String(event.objective ?? ""),
				title: undefined,
			};
			const result = enqueueTimeline(fork, entry, 0);
			emitIfChanged(fork, result, emit);
			return result;
		},
		skill_activated: ({ fork, event }) => {
			if (event.source !== "user") return fork;
			const text = event.message != null ? `/${event.skillName} ${event.message}` : `/${event.skillName}`;
			const entry: WindowTimelineEntry = {
				kind: "user_message",
				timestamp: event.timestamp,
				text,
				synthetic: false,
				attachments: [],
			};
			return enqueueTimeline(fork, entry, 0);
		},
		user_bash_command: ({ fork, event }) =>
			enqueueTimeline(
				fork,
				{
					kind: "user_bash_command",
					timestamp: event.timestamp,
					command: event.command,
					cwd: event.cwd,
					exitCode: event.exitCode,
					stdout: event.stdout,
					stderr: event.stderr,
				},
				0,
			),
		turn_started: ({ fork, event, emit }) => {
			let nextFork: WindowForkState = {
				...fork,
				_activeMessageIsCoordinator: false,
				_coordinatorChars: 0,
			};
			nextFork = enqueueTimeline(nextFork, { kind: "turn_start", timestamp: event.timestamp }, 0);
			const result: WindowForkState = {
				...nextFork,
				currentTurnId: event.turnId,
				currentChainId: event.chainId,
			};
			emitIfChanged(fork, result, emit);
			return result;
		},
		observations_captured: ({ fork, event, emit }) => {
			if (fork.currentTurnId !== event.turnId) return fork;
			const nextFork = enqueueTimeline(
				fork,
				{
					kind: "observation",
					timestamp: event.timestamp,
					parts: event.parts,
				},
				0,
			);
			emitIfChanged(fork, nextFork, emit);
			return nextFork;
		},
		message_start: ({ fork, event }) => {
			if (fork.currentTurnId !== event.turnId) return fork;
			return {
				...fork,
				_activeMessageIsCoordinator: event.destination.kind === "coordinator",
			};
		},
		message_chunk: ({ fork, event }) => {
			if (fork.currentTurnId !== event.turnId) return fork;
			if (!fork._activeMessageIsCoordinator) return fork;
			return { ...fork, _coordinatorChars: fork._coordinatorChars + event.text.length };
		},
		message_end: ({ fork, event }) => {
			if (fork.currentTurnId !== event.turnId) return fork;
			return { ...fork, _activeMessageIsCoordinator: false };
		},
		turn_outcome: ({ fork, event, emit }) => {
			if (fork.currentTurnId !== event.turnId) return fork;
			const outcome = event.outcome;
			const feedback: FeedbackEntry[] = [];
			if (fork._coordinatorChars > 0) {
				feedback.push({ kind: "message_ack", destination: "coordinator", chars: fork._coordinatorChars });
			}
			let clean = false;
			if (outcome && typeof outcome === "object" && "_tag" in outcome) {
				const tag = outcome._tag;
				if (tag === "Completed") clean = true;
				if (tag === "Cancelled") feedback.push({ kind: "interrupted" });
				if (tag === "SystemError") {
					const message = outcome.message ?? "Unknown error";
					feedback.push({ kind: "error", message });
				}
				if (tag === "ContextWindowExceeded" || tag === "SafetyStop" || tag === "UnexpectedError") {
					feedback.push({ kind: "error", message: "Context limit or safety stop reached." });
				}
			}
			const assistantTurn: WindowTimelineEntry = {
				kind: "assistant_turn",
				turnId: event.turnId,
				feedback,
				clean,
			};
			const newMessages = [...fork.messages, assistantTurn];
			const turnEntryTokens = 0;
			const messageTokens = fork.messageTokens + turnEntryTokens;
			let nextFork: WindowForkState;
			if (event.inputTokens != null) {
				nextFork = {
					...fork,
					messages: newMessages,
					currentTurnId: null,
					messageTokens,
					lastAnchoredTotal: event.inputTokens,
					lastAnchoredMessageTokens: messageTokens,
					tokenEstimate: event.inputTokens,
				};
			} else {
				nextFork = {
					...fork,
					messages: newMessages,
					currentTurnId: null,
					messageTokens,
					tokenEstimate: computeTokenEstimate(fork, messageTokens),
				};
			}
			const result = enqueueTimeline(nextFork, { kind: "turn_end" }, 0);
			emitIfChanged(fork, result, emit);
			return result;
		},
		interrupt: ({ fork }) => fork,
		image_descriptions_resolved: ({ fork }) => fork,
		observer_outcome: ({ fork, event }) => {
			const entry: WindowTimelineEntry = {
				kind: "observer_turn",
				observerTurnId: String(event.observerTurnId ?? ""),
				justification: event.justification,
				escalate: Boolean(event.escalate),
				reasoning: event.reasoning,
			};
			return enqueueTimeline(fork, entry, 0);
		},
	},
	globalEventHandlers: {
		shell_process_exited: ({ event, state }) => {
			const stdoutPath = "";
			const stderrPath = "";
			const entry: WindowTimelineEntry = {
				kind: "detached_process_exited",
				timestamp: event.timestamp,
				pid: event.pid,
				command: event.command,
				exitCode: event.exitCode,
				stdoutPath,
				stderrPath,
			};
			let nextState = state;
			const ownerFork = nextState.forks.get(event.forkId);
			if (ownerFork) {
				const nextFork = enqueueTimeline(ownerFork, entry, 0);
				nextState = { ...nextState, forks: new Map(nextState.forks).set(event.forkId, nextFork) };
			}
			if (event.forkId !== null) {
				const rootFork = nextState.forks.get(null);
				if (rootFork) {
					const nextRoot = enqueueTimeline(rootFork, entry, 0);
					nextState = { ...nextState, forks: new Map(nextState.forks).set(null, nextRoot) };
				}
			}
			return nextState;
		},
		agent_task_changed: ({ event, state }) => {
			const workerFork = state.forks.get(event.forkId);
			if (workerFork) {
				const reassignedEntry: WindowTimelineEntry = {
					kind: "task_reassigned",
				};
				const nextFork = enqueueTimeline(workerFork, reassignedEntry, 0);
				let nextState = { ...state, forks: new Map(state.forks).set(event.forkId, nextFork) };
				const rootFork = nextState.forks.get(null);
				if (rootFork) {
					const leaderEntry: WindowTimelineEntry = {
						kind: "task_update",
						action: "status_changed",
						taskId: event.newTaskId,
						title: undefined,
						previousStatus: `worker ${event.agentId} on ${event.oldTaskId}`,
						nextStatus: `worker ${event.agentId} on ${event.newTaskId}`,
					};
					const nextRoot = enqueueTimeline(rootFork, leaderEntry, 0);
					nextState = { ...nextState, forks: new Map(nextState.forks).set(null, nextRoot) };
				}
				return nextState;
			}
			return state;
		},
		agent_created: ({ event, state }) => {
			const { forkId, parentForkId } = event;
			const parentState = state.forks.get(parentForkId);
			if (!parentState) return state;
			const coordinatorMessageEntry: WindowTimelineEntry = {
				kind: "coordinator_message",
				timestamp: event.timestamp,
				text: event.message ?? "",
			};
			const newForkState: WindowForkState = {
				...initialFork,
				messages: [...parentState.messages],
				tokenEstimate: parentState.tokenEstimate,
				messageTokens: parentState.messageTokens,
				systemPromptTokens: parentState.systemPromptTokens,
			};
			const enqueued = enqueueTimeline(newForkState, coordinatorMessageEntry, 0);
			return { ...state, forks: new Map(state.forks).set(forkId, enqueued) };
		},
		observer_outcome: ({ event, state }) => {
			if (!event.escalate) return state;
			if (event.forkId === null) {
				const rootFork = state.forks.get(null);
				if (!rootFork) return state;
				const escalationEntry: WindowTimelineEntry = {
					kind: "escalation",
					timestamp: Date.now(),
					observedForkId: null,
					justification: event.justification,
				};
				const nextRoot = enqueueTimeline(rootFork, escalationEntry, 0);
				return { ...state, forks: new Map(state.forks).set(null, nextRoot) };
			}
			const observedFork = state.forks.get(event.forkId);
			const rootFork = state.forks.get(null);
			if (!observedFork && !rootFork) return state;
			const escalationEntry: WindowTimelineEntry = {
				kind: "escalation",
				timestamp: Date.now(),
				observedForkId: event.forkId,
				justification: event.justification,
			};
			let forks = new Map(state.forks);
			if (observedFork) {
				forks = forks.set(event.forkId, enqueueTimeline(observedFork, escalationEntry, 0));
			}
			if (rootFork) {
				forks = forks.set(null, enqueueTimeline(rootFork, escalationEntry, 0));
			}
			return { ...state, forks };
		},
	},
	signalHandlers: (on) => [
		on(AgentStatusProjection.signals.agentBecameIdle, ({ value, state }) => {
			const parentState = state.forks.get(value.parentForkId);
			if (!parentState) return state;
			const idleAtom: WindowAgentAtom = {
				kind: "idle",
			};
			const nextParent = enqueueTimeline(
				parentState,
				{
					kind: "agent_block",
					timestamp: value.timestamp,
					agentId: value.agentId,
					role: value.role,
					atoms: [idleAtom],
				},
				0,
			);
			return {
				...state,
				forks: new Map(state.forks).set(value.parentForkId, nextParent),
			};
		}),
		on(AgentStatusProjection.signals.subagentUserKilled, ({ value, state }) => {
			const parentState = state.forks.get(value.parentForkId);
			if (!parentState) return state;
			const nextParent = enqueueTimeline(
				parentState,
				{
					kind: "worker_user_killed",
					timestamp: value.timestamp,
					agentId: value.agentId,
					agentType: value.role,
				},
				0,
			);
			return {
				...state,
				forks: new Map(state.forks).set(value.parentForkId, nextParent),
			};
		}),
		on(UserMessageResolutionProjection.signals.userMessageResolved, ({ value, state, read }) => {
			const targetFork = state.forks.get(value.forkId);
			if (!targetFork) return state;
			const text = typeof value.content === "string" ? value.content : JSON.stringify(value.content ?? "");
			const userEntry: WindowTimelineEntry = {
				kind: "user_message",
				timestamp: value.timestamp,
				text,
				attachments: [],
				synthetic: Boolean(value.synthetic),
			};
			let nextFork = enqueueTimeline(targetFork, userEntry, 0);
			if (value.forkId !== null) {
				const agentStatus = readAgentStatus(read);
				const agent = agentStatus ? getAgentByForkId(agentStatus, value.forkId) : undefined;
				if (agent) {
					nextFork = enqueueTimeline(
						nextFork,
						{
							kind: "user_to_agent",
							timestamp: value.timestamp,
							agentId: agent.agentId,
							text,
						},
						0,
					);
				}
			}
			return {
				...state,
				forks: new Map(state.forks).set(value.forkId, nextFork),
			};
		}),
	],
});

// ─── Emit helper ────────────────────────────────────────────────────────────

function emitIfChanged(
	oldFork: WindowForkState,
	newFork: WindowForkState,
	emit: Record<string, (value: unknown) => void>,
): void {
	if (newFork.tokenEstimate !== oldFork.tokenEstimate) {
		emit.tokenEstimateChanged({
			forkId: newFork.currentTurnId,
			tokenEstimate: newFork.tokenEstimate,
		});
	}
}
