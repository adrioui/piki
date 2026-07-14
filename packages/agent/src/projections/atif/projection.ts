// packages/agent/src/projections/atif/projection.ts
//
// AtifProjection records the per-fork trajectory as an ordered list of steps,
// mapping piki runtime events to the ATIF step vocabulary. The projection is
// forked (one step list per fork, plus the root fork). Recording is gated on
// the AtifAmbient `enabled` flag. Step recording is internal and always
// happens once enabled; persistence is a separate concern owned by AtifWriter.

import { defineForkedProjection, type ProjectionRef } from "@piki/event-core";
import { type AgentInfo, AgentStatusProjection, type AgentStatusState } from "../agent-status.ts";
import { CompactionConfigAmbient } from "../compaction-config.ts";
import { AtifAmbient, type AtifConfig } from "./ambient.ts";

// ─── Step vocabulary (structural match for ATIF-v1.7) ───────────────────────

export type AtifStep =
	| {
			kind: "user_message";
			forkId: string | null;
			timestamp: number;
			messageId: string;
			text: string;
			synthetic?: boolean;
	  }
	| {
			kind: "turn_started";
			forkId: string | null;
			timestamp: number;
			turnId: string;
			chainId: string | null;
			agentId?: string;
	  }
	| { kind: "thinking_chunk"; forkId: string | null; timestamp: number; turnId: string; text: string }
	| {
			kind: "message_chunk";
			forkId: string | null;
			timestamp: number;
			turnId: string;
			destination: string;
			text: string;
	  }
	| {
			kind: "tool_event";
			forkId: string | null;
			timestamp: number;
			turnId: string;
			toolName: string;
			callId?: string;
			input?: unknown;
			output?: unknown;
			error?: string;
	  }
	| {
			kind: "turn_ended";
			forkId: string | null;
			timestamp: number;
			turnId: string;
			outcome: { _tag: string; reason?: string };
			clean: boolean;
			feedback: ReadonlyArray<unknown>;
	  }
	| { kind: "goal"; forkId: string | null; timestamp: number; goalId: string; objective: string; finished?: boolean }
	| { kind: "observation"; forkId: string | null; timestamp: number; turnId: string; parts: ReadonlyArray<unknown> }
	| {
			kind: "escalation";
			forkId: string | null;
			timestamp: number;
			observedForkId: string | null;
			justification?: unknown;
	  }
	| {
			kind: "fork_created";
			forkId: string;
			parentForkId: string | null;
			timestamp: number;
			agentId: string;
			role: string;
			taskId: string;
	  }
	| { kind: "fork_completed"; forkId: string; timestamp: number; reason: string };

// ─── Fork state ─────────────────────────────────────────────────────────────

export interface AtifForkState {
	readonly steps: ReadonlyArray<AtifStep>;
	readonly seq: number;
}

const initialFork: AtifForkState = { steps: [], seq: 0 };

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

function readAtifConfig(ambient: { get: (def: typeof AtifAmbient) => unknown }): AtifConfig {
	return ambient.get(AtifAmbient) as AtifConfig;
}

function getForkMap(state: unknown): Map<string | null, AtifForkState> {
	return (state as { forks: Map<string | null, AtifForkState> }).forks;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Derive the coordinator-feedback list from a turn outcome, matching the window projection. */
function deriveFeedback(outcome: { _tag: string; reason?: string }, coordinatorChars: number): ReadonlyArray<unknown> {
	const feedback: Array<unknown> = [];
	if (coordinatorChars > 0) {
		feedback.push({ kind: "message_ack", destination: "coordinator", chars: coordinatorChars });
	}
	const tag = outcome._tag;
	if (tag === "Cancelled") feedback.push({ kind: "interrupted" });
	if (tag === "SystemError") {
		feedback.push({ kind: "error", message: outcome.reason ?? "Unknown error" });
	}
	if (tag === "ContextWindowExceeded" || tag === "SafetyStop" || tag === "UnexpectedError") {
		feedback.push({ kind: "error", message: "Context limit or safety stop reached." });
	}
	return feedback;
}

/** Append a step and emit stepAdded after the state update (mirrors window-projection emit pattern). */
function withStep(fork: AtifForkState, step: AtifStep, emit: Record<string, (value: unknown) => void>): AtifForkState {
	const next: AtifForkState = {
		steps: [...fork.steps, step],
		seq: fork.seq + 1,
	};
	emit.stepAdded({ forkId: next.steps[next.steps.length - 1].forkId ?? null, step });
	return next;
}

// ─── Projection factory ─────────────────────────────────────────────────────

export const AtifProjection = defineForkedProjection()<AtifForkState>({
	name: "Atif",
	reads: [AgentStatusProjection],
	ambients: [AtifAmbient, CompactionConfigAmbient],
	signals: {
		stepAdded: { name: "Atif/stepAdded" },
		forkCompleted: { name: "Atif/forkCompleted" },
	},
	initialFork,
	eventHandlers: {
		user_message: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			const step: AtifStep = {
				kind: "user_message",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				messageId: String(event.messageId ?? ""),
				text: String(event.content ?? ""),
				synthetic: Boolean(event.synthetic ?? false),
			};
			return withStep(fork, step, emit);
		},
		turn_started: ({ fork, event, emit, ambient, read }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			const agentStatus = readAgentStatus(read);
			const agent = agentStatus ? getAgentByForkId(agentStatus, event.forkId ?? "") : undefined;
			const step: AtifStep = {
				kind: "turn_started",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				turnId: String(event.turnId ?? ""),
				chainId: event.chainId != null ? String(event.chainId) : null,
				agentId: agent?.agentId,
			};
			return withStep(fork, step, emit);
		},
		message_start: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			if (event.destination?.kind !== "coordinator") return fork;
			const step: AtifStep = {
				kind: "thinking_chunk",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				turnId: String(event.turnId ?? ""),
				text: "",
			};
			return withStep(fork, step, emit);
		},
		message_chunk: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			if (event.destination?.kind !== "coordinator") return fork;
			const step: AtifStep = {
				kind: "thinking_chunk",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				turnId: String(event.turnId ?? ""),
				text: String(event.text ?? ""),
			};
			return withStep(fork, step, emit);
		},
		tool_execution_start: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			const step: AtifStep = {
				kind: "tool_event",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				turnId: String(event.turnId ?? ""),
				toolName: String(event.toolName ?? ""),
				callId: event.toolCallId != null ? String(event.toolCallId) : undefined,
				input: event.args,
			};
			return withStep(fork, step, emit);
		},
		tool_execution_update: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			const step: AtifStep = {
				kind: "tool_event",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				turnId: String(event.turnId ?? ""),
				toolName: String(event.toolName ?? ""),
				callId: event.toolCallId != null ? String(event.toolCallId) : undefined,
				output: event.partialResult,
			};
			return withStep(fork, step, emit);
		},
		tool_execution_end: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			const step: AtifStep = {
				kind: "tool_event",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				turnId: String(event.turnId ?? ""),
				toolName: String(event.toolName ?? ""),
				callId: event.toolCallId != null ? String(event.toolCallId) : undefined,
				output: event.result,
				error: event.isError ? String(event.result) : undefined,
			};
			return withStep(fork, step, emit);
		},
		turn_outcome: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			const outcome = event.outcome ?? { _tag: "Unknown" };
			const feedback = deriveFeedback(outcome, 0);
			const clean = outcome._tag === "Completed";
			const step: AtifStep = {
				kind: "turn_ended",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				turnId: String(event.turnId ?? ""),
				outcome: {
					_tag: String(outcome._tag),
					reason: typeof outcome.reason === "string" ? outcome.reason : undefined,
				},
				clean,
				feedback,
			};
			return withStep(fork, step, emit);
		},
		goal_started: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			const step: AtifStep = {
				kind: "goal",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				goalId: String(event.goalId ?? ""),
				objective: String(event.objective ?? ""),
				finished: false,
			};
			return withStep(fork, step, emit);
		},
		goal_finished: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			const step: AtifStep = {
				kind: "goal",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				goalId: String(event.goalId ?? ""),
				objective: String(event.objective ?? ""),
				finished: true,
			};
			return withStep(fork, step, emit);
		},
		observations_captured: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			const step: AtifStep = {
				kind: "observation",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				turnId: String(event.turnId ?? ""),
				parts: event.parts,
			};
			return withStep(fork, step, emit);
		},
		observer_outcome: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			if (!event.escalate) return fork;
			const step: AtifStep = {
				kind: "escalation",
				forkId: event.forkId ?? null,
				timestamp: event.timestamp,
				observedForkId: event.forkId != null ? String(event.forkId) : null,
				justification: event.justification,
			};
			const next = withStep(fork, step, emit);
			emit.forkCompleted({ forkId: event.forkId ?? null, reason: "escalation" });
			return next;
		},
		agent_killed: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			if (event.forkId == null) return fork;
			const step: AtifStep = {
				kind: "fork_completed",
				forkId: String(event.forkId),
				timestamp: event.timestamp,
				reason: "killed",
			};
			const next = withStep(fork, step, emit);
			emit.forkCompleted({ forkId: String(event.forkId), reason: "killed" });
			return next;
		},
		worker_user_killed: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			if (event.forkId == null) return fork;
			const step: AtifStep = {
				kind: "fork_completed",
				forkId: String(event.forkId),
				timestamp: event.timestamp,
				reason: "user_killed",
			};
			const next = withStep(fork, step, emit);
			emit.forkCompleted({ forkId: String(event.forkId), reason: "user_killed" });
			return next;
		},
		worker_idle_closed: ({ fork, event, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return fork;
			if (event.forkId == null) return fork;
			const step: AtifStep = {
				kind: "fork_completed",
				forkId: String(event.forkId),
				timestamp: event.timestamp,
				reason: "idle_closed",
			};
			const next = withStep(fork, step, emit);
			emit.forkCompleted({ forkId: String(event.forkId), reason: "idle_closed" });
			return next;
		},
	},
	globalEventHandlers: {
		agent_created: ({ event, state, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return state;
			const { forkId, parentForkId } = event;
			if (forkId == null) return state;
			const step: AtifStep = {
				kind: "fork_created",
				forkId: String(forkId),
				parentForkId: parentForkId != null ? String(parentForkId) : null,
				timestamp: event.timestamp,
				agentId: String(event.agentId ?? ""),
				role: String(event.role ?? ""),
				taskId: String(event.taskId ?? ""),
			};
			const newFork: AtifForkState = {
				steps: [step],
				seq: 1,
			};
			emit.stepAdded({ forkId: String(forkId), step });
			const forks = new Map(getForkMap(state));
			forks.set(String(forkId), newFork);
			return { ...state, forks };
		},
		observer_outcome: ({ event, state, emit, ambient }) => {
			if (!readAtifConfig(ambient).enabled) return state;
			if (!event.escalate) return state;
			const step: AtifStep = {
				kind: "escalation",
				forkId: null,
				timestamp: event.timestamp,
				observedForkId: event.forkId != null ? String(event.forkId) : null,
				justification: event.justification,
			};
			let forks = new Map(getForkMap(state));
			const append = (targetForkId: string | null) => {
				const target = targetForkId != null ? forks.get(String(targetForkId)) : forks.get(null);
				if (!target) return;
				const next: AtifForkState = {
					steps: [...target.steps, step],
					seq: target.seq + 1,
				};
				emit.stepAdded({ forkId: targetForkId, step });
				if (targetForkId != null) {
					forks = forks.set(String(targetForkId), next);
				} else {
					forks = forks.set(null, next);
				}
			};
			if (event.forkId !== null) append(String(event.forkId));
			append(null);
			return { ...state, forks };
		},
	},
});
