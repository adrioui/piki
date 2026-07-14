// packages/agent/src/projections/turn.ts
//
// TurnProjection tracks per-fork turn lifecycle state. It is a forked
// projection whose fork state is a tagged FSM (`idle` | `active` |
// `interrupting` | `waiting_for_user`) carrying pending `triggers` that decide
// when a new turn may start, plus inbound communication buffering and cross-fork
// wake propagation.
//
// `TurnController` reads `turnFork._tag` (to detect idle forks) and
// `turnFork.triggers` (to detect due triggers).

import { defineForkedProjection, type ProjectionRef } from "@piki/event-core";
import { uuidv7 } from "../harness/session/uuid.ts";
import { AgentRoutingProjection } from "./agent-routing.ts";
import { AgentStatusProjection, type AgentStatusState } from "./agent-status.ts";
import { GoalProjection, type GoalState } from "./goal.ts";
import { UserMessageResolutionProjection } from "./user-message-resolution.ts";

// ─── Retry backoff ────────────────────────────────────────────────────────────

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30000;

function computeDelayMs(attempt: number, hintMs: number | undefined): number {
	const computed = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
	return hintMs !== undefined ? Math.max(hintMs, computed) : computed;
}

function getRetryAfterHint(outcome: unknown): number | undefined {
	if (outcome === null || typeof outcome !== "object") return undefined;
	const o = outcome as { _tag?: string; detail?: { failure?: { retryAfterMs?: number } } };
	if (o._tag !== "ConnectionFailure") return undefined;
	return o.detail?.failure?.retryAfterMs ?? undefined;
}

// ─── Trigger vocabulary ────────────────────────────────────────────────────
// A trigger marks why a fork wants a turn. `chain_continue` carries a `chainId`
// and an optional `notBefore` epoch-ms gate used for retry backoff.

export type TurnTrigger =
	| { readonly _tag: "wake" }
	| { readonly _tag: "communication" }
	| { readonly _tag: "agent_created"; readonly agentId: string }
	| { readonly _tag: "chain_continue"; readonly chainId: string; readonly notBefore?: number };

// ─── Inbound communication buffer ────────────────────────────────────────────

export interface PendingInboundCommunication {
	readonly id: string;
	readonly source: string;
	readonly direction: "from_agent" | "to_agent";
	readonly agentId: string;
	readonly forkId: string | null;
	readonly content: string;
	readonly preview: string;
	readonly timestamp: number;
	readonly arrivedAtTurnId: string | null;
}

// ─── Fork state ──────────────────────────────────────────────────────────────

export type TurnPhase = "idle" | "active" | "interrupting" | "waiting_for_user";

export interface TurnForkState {
	readonly _tag: TurnPhase;
	readonly turnId: string | null;
	readonly chainId: string | null;
	readonly completedTurns: number;
	readonly triggers: ReadonlyArray<TurnTrigger>;
	readonly pendingInboundCommunications: ReadonlyArray<PendingInboundCommunication>;
	readonly parentForkId: string | null;
	readonly connectionRetryCount: number;
	readonly triggeredByUser: boolean;
	readonly requiresAdvisor: boolean;
}

const initialIdle: TurnForkState = {
	_tag: "idle",
	turnId: null,
	chainId: null,
	completedTurns: 0,
	triggers: [],
	pendingInboundCommunications: [],
	parentForkId: null,
	connectionRetryCount: 0,
	triggeredByUser: false,
	requiresAdvisor: false,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function holdFork(state: TurnForkState, patch: Partial<TurnForkState>): TurnForkState {
	return { ...state, ...patch };
}

function transitionFork(state: TurnForkState, _tag: TurnPhase, patch: Partial<TurnForkState>): TurnForkState {
	return { ...state, _tag, ...patch };
}

function clearTriggers(state: TurnForkState): TurnForkState {
	return holdFork(state, { triggers: [] });
}

function enqueueTrigger(state: TurnForkState, trigger: TurnTrigger): TurnForkState {
	return holdFork(state, { triggers: [...state.triggers, trigger] });
}

// `hasPendingAdvisorRequirement` is currently a hard-coded `false`. Kept as a
// named predicate for clarity; it may become role-driven later.
function hasPendingAdvisorRequirement(_fork: TurnForkState): boolean {
	return false;
}

function hasActiveWorkers(state: AgentStatusState): boolean {
	return Array.from(state.agents.values()).some((agent) => agent.status === "working");
}

function toPreview(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= 120) return normalized;
	return `${normalized.slice(0, 117)}...`;
}

function extractTextFromParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part !== null && typeof part === "object" && part._tag === "TextPart")
			.map((part) => part.text ?? "")
			.join("");
	}
	if (content !== null && typeof content === "object" && "text" in content) {
		return String(content.text);
	}
	return "";
}

function makeShortId(): string {
	return uuidv7().slice(0, 12);
}

function readGoalState(read: (projection: ProjectionRef) => unknown): GoalState | null {
	const value = read(GoalProjection);
	return value == null ? null : (value as GoalState);
}

function readAgentStatusState(read: (projection: ProjectionRef) => unknown): AgentStatusState | null {
	const value = read(AgentStatusProjection);
	return value == null ? null : (value as AgentStatusState);
}

// ─── Projection factory ───────────────────────────────────────────────────────

export const TurnProjection = defineForkedProjection()({
	name: "Turn",
	reads: [AgentStatusProjection, AgentRoutingProjection, UserMessageResolutionProjection, GoalProjection],
	initialFork: initialIdle,
	signals: {
		turnActivated: { name: "Turn/turnActivated" },
		turnInterrupting: { name: "Turn/turnInterrupting" },
		turnTerminated: { name: "Turn/turnTerminated" },
		pendingInboundCommunicationsRead: { name: "Turn/pendingInboundCommunicationsRead" },
	},
	eventHandlers: {
		interrupt: ({ event, fork, emit }) => {
			const isRoot = event.forkId === null;
			const advisorRequirementPending = isRoot && hasPendingAdvisorRequirement(fork);
			const afterClear = clearTriggers(fork);
			if (advisorRequirementPending) {
				if (afterClear._tag === "waiting_for_user") return afterClear;
				if (afterClear._tag === "interrupting") return afterClear;
			}
			if (afterClear._tag === "waiting_for_user") return afterClear;
			if (afterClear._tag === "active") {
				emit.turnInterrupting({
					forkId: event.forkId,
					turnId: afterClear.turnId,
				});
				return transitionFork(afterClear, "interrupting", {
					triggeredByUser: afterClear.triggeredByUser,
				});
			}
			if (isRoot) {
				return transitionFork(afterClear, "waiting_for_user", {});
			}
			return afterClear;
		},
		wake: ({ fork }) => enqueueTrigger(fork, { _tag: "wake" }),
		goal_started: ({ event, fork }) => {
			if (event.forkId !== null) return fork;
			const triggers = fork.triggers.some((trigger: TurnTrigger) => trigger._tag === "wake")
				? fork.triggers
				: [...fork.triggers, { _tag: "wake" }];
			if (fork._tag === "waiting_for_user") {
				return transitionFork(fork, "idle", { triggers });
			}
			return holdFork(fork, { triggers });
		},
		agent_created: ({ event, fork }) => {
			const withParent = holdFork(fork, { parentForkId: event.parentForkId ?? null });
			if (event.message == null) return withParent;
			return enqueueTrigger(withParent, { _tag: "agent_created", agentId: event.agentId });
		},
		turn_started: ({ event, fork, emit }) => {
			if (fork._tag !== "idle") {
				return fork;
			}
			const requiresAdvisor = event.forkId === null && hasPendingAdvisorRequirement(fork);
			if (fork.pendingInboundCommunications.length > 0) {
				emit.pendingInboundCommunicationsRead({
					forkId: event.forkId,
					turnId: event.turnId,
					messages: fork.pendingInboundCommunications,
					timestamp: event.timestamp,
				});
			}
			emit.turnActivated({
				forkId: event.forkId,
				turnId: event.turnId,
				chainId: event.chainId,
			});
			return transitionFork(fork, "active", {
				turnId: event.turnId,
				chainId: event.chainId,
				triggers: [],
				pendingInboundCommunications: [],
				triggeredByUser: fork.pendingInboundCommunications.some(
					(message: PendingInboundCommunication) => message.source === "user",
				),
				requiresAdvisor,
			});
		},
		turn_outcome: ({ event, fork, emit, read }) => {
			if (fork._tag === "idle" || fork._tag === "waiting_for_user") return fork;
			if (fork.turnId !== event.turnId) return fork;
			const isRoot = event.forkId === null;
			const outcome = event.outcome;
			const isUserInterruptedRoot =
				isRoot &&
				fork._tag === "interrupting" &&
				outcome._tag === "Cancelled" &&
				outcome.reason?._tag === "UserInterrupt";
			const shouldEnqueueContinue =
				typeof outcome === "object" &&
				(outcome.chaining === true ||
					outcome.willContinue === true ||
					outcome.reason === "continue" ||
					outcome._tag === "Continue");
			const isConnectionFailure = outcome._tag === "ConnectionFailure";
			void hasPendingAdvisorRequirement(fork);
			const nextRetryCount = isConnectionFailure ? fork.connectionRetryCount + 1 : 0;
			const notBefore =
				shouldEnqueueContinue && isConnectionFailure
					? event.timestamp + computeDelayMs(fork.connectionRetryCount, getRetryAfterHint(outcome))
					: undefined;
			const goalState: GoalState | null = isRoot ? readGoalState(read) : null;
			const agentStatus: AgentStatusState | null = isRoot ? readAgentStatusState(read) : null;
			const isUserInterrupt = outcome._tag === "Cancelled" && outcome.reason?._tag === "UserInterrupt";
			const shouldEnqueueGoalReminder =
				isRoot &&
				!shouldEnqueueContinue &&
				!isUserInterrupt &&
				goalState?.active != null &&
				agentStatus !== null &&
				!hasActiveWorkers(agentStatus);
			const nextTriggers = shouldEnqueueContinue
				? [
						...fork.triggers,
						{
							_tag: "chain_continue",
							chainId: fork.chainId ?? "",
							...(notBefore !== undefined ? { notBefore } : {}),
						},
					]
				: shouldEnqueueGoalReminder
					? [...fork.triggers, { _tag: "wake" }]
					: fork.triggers;
			emit.turnTerminated({
				forkId: event.forkId,
				turnId: event.turnId,
				reason: outcome._tag === "Cancelled" ? "cancelled" : outcome._tag === "Completed" ? "completed" : "error",
				result: event.outcome,
				triggersQueued: isUserInterruptedRoot ? false : nextTriggers.length > 0,
			});
			if (isUserInterruptedRoot) {
				return transitionFork(fork, "waiting_for_user", {
					completedTurns: fork.completedTurns + 1,
					triggers: [],
					connectionRetryCount: 0,
				});
			}
			return transitionFork(fork, "idle", {
				completedTurns: fork.completedTurns + 1,
				triggers: nextTriggers,
				connectionRetryCount: nextRetryCount,
			});
		},
		shell_completed: ({ fork }) => {
			if (fork._tag === "interrupting") return fork;
			if (fork._tag === "idle" || fork._tag === "waiting_for_user") {
				return enqueueTrigger(fork, { _tag: "wake" });
			}
			return fork;
		},
	},
	globalEventHandlers: {
		turn_outcome: ({ event, state }) => {
			if (event.forkId === null) return state;
			const subFork = state.forks.get(event.forkId);
			if (!subFork) return state;
			if (subFork._tag !== "idle" || subFork.triggers.length > 0) return state;
			const isUserKilled = event.outcome._tag === "Cancelled" && event.outcome.reason?._tag === "UserInterrupt";
			if (isUserKilled) return state;
			const parentId = subFork.parentForkId;
			const parentFork = parentId !== null ? state.forks.get(parentId) : undefined;
			if (!parentFork) return state;
			const nextParent = enqueueTrigger(parentFork, { _tag: "wake" });
			const newForks = new Map(state.forks);
			newForks.set(parentId, nextParent);
			return { ...state, forks: newForks };
		},
		subagent_user_killed: ({ event, state }) => {
			const parentId = event.parentForkId;
			if (parentId === null) return state;
			const subFork = event.forkId != null ? state.forks.get(event.forkId) : undefined;
			if (subFork && subFork._tag === "idle" && subFork.triggers.length === 0) return state;
			const parentFork = state.forks.get(parentId);
			if (!parentFork) return state;
			const nextParent = enqueueTrigger(parentFork, { _tag: "wake" });
			const newForks = new Map(state.forks);
			newForks.set(parentId, nextParent);
			return { ...state, forks: newForks };
		},
		observer_outcome: ({ state }) => state,
	},
	signalHandlers: (on) => [
		on(UserMessageResolutionProjection.signals.userMessageResolved, ({ value, state }) => {
			const forkId = value.forkId;
			if (forkId === null) return state;
			const fork = state.forks.get(forkId);
			if (!fork) return state;
			const contentText = extractTextFromParts(value.content);
			if (fork._tag === "waiting_for_user") {
				const next = transitionFork(fork, "idle", {
					triggers: [...fork.triggers, { _tag: "communication" }],
					pendingInboundCommunications: [
						...fork.pendingInboundCommunications,
						{
							id: makeShortId(),
							source: "user",
							direction: "from_agent",
							agentId: "user",
							forkId,
							content: contentText,
							preview: toPreview(contentText),
							timestamp: value.timestamp,
							arrivedAtTurnId: null,
						},
					],
				});
				const newForks = new Map(state.forks);
				newForks.set(forkId, next);
				return { ...state, forks: newForks };
			}
			const next = holdFork(fork, {
				triggers: [...fork.triggers, { _tag: "communication" }],
				pendingInboundCommunications: [
					...fork.pendingInboundCommunications,
					{
						id: makeShortId(),
						source: "user",
						direction: "from_agent",
						agentId: "user",
						forkId,
						content: contentText,
						preview: toPreview(contentText),
						timestamp: value.timestamp,
						arrivedAtTurnId: fork._tag === "idle" ? null : fork.turnId,
					},
				],
			});
			const newForks = new Map(state.forks);
			newForks.set(forkId, next);
			return { ...state, forks: newForks };
		}),
		on(AgentRoutingProjection.signals.agentResponse, ({ value, state }) => {
			const forkId = value.targetForkId;
			if (forkId === null) return state;
			const fork = state.forks.get(forkId);
			if (!fork) return state;
			const next = holdFork(fork, {
				triggers: [...fork.triggers, { _tag: "communication" }],
				pendingInboundCommunications: [
					...fork.pendingInboundCommunications,
					{
						id: makeShortId(),
						source: value.agentId,
						direction: "from_agent",
						agentId: value.agentId,
						forkId,
						content: value.message,
						preview: toPreview(value.message),
						timestamp: value.timestamp,
						arrivedAtTurnId: fork._tag === "idle" || fork._tag === "waiting_for_user" ? null : fork.turnId,
					},
				],
			});
			const newForks = new Map(state.forks);
			newForks.set(forkId, next);
			return { ...state, forks: newForks };
		}),
		on(AgentRoutingProjection.signals.agentMessage, ({ value, state }) => {
			const forkId = value.targetForkId;
			if (forkId === null) return state;
			const fork = state.forks.get(forkId);
			if (!fork) return state;
			const next = holdFork(fork, {
				triggers: [...fork.triggers, { _tag: "communication" }],
				pendingInboundCommunications: [
					...fork.pendingInboundCommunications,
					{
						id: makeShortId(),
						source: value.agentId,
						direction: "from_agent",
						agentId: value.agentId,
						forkId,
						content: value.message,
						preview: toPreview(value.message),
						timestamp: value.timestamp,
						arrivedAtTurnId: fork._tag === "idle" || fork._tag === "waiting_for_user" ? null : fork.turnId,
					},
				],
			});
			const newForks = new Map(state.forks);
			newForks.set(forkId, next);
			return { ...state, forks: newForks };
		}),
	],
});
