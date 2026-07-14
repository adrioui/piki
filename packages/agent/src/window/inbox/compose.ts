/**
 * Timeline event constructors.
 *
 *
 * These are pure value factories that build the typed `TimelineEntry` variants
 * consumed by the timeline renderer (`window/render/full.ts`). They intentionally
 * contain no business logic or effectful work, so they are plain typed functions
 * rather than `Effect.fn` wrappers (which are reserved for functions that produce
 * `Effect<A, E, R>`).
 */

import type { AgentAtom, TimelineAttachment, TimelineEntry } from "../render/full.ts";

/** `Omit` that distributes over a union so per-variant arg types stay precise. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Variant<K extends TimelineEntry["kind"]> = Extract<TimelineEntry, { kind: K }>;
type Args<K extends TimelineEntry["kind"]> = DistributiveOmit<Variant<K>, "kind">;

export function toTimelineTurnStart(args: Args<"turn_start">): Variant<"turn_start"> {
	return { kind: "turn_start", ...args };
}

export function toTimelineTurnEnd(args: Args<"turn_end">): Variant<"turn_end"> {
	return { kind: "turn_end", ...args };
}

export function toTimelineUserMessage(args: Args<"user_message">): Variant<"user_message"> {
	return { kind: "user_message", ...args };
}

export function toTimelineCoordinatorMessage(args: Args<"coordinator_message">): Variant<"coordinator_message"> {
	return { kind: "coordinator_message", ...args };
}

export function toTimelineUserBashCommand(args: Args<"user_bash_command">): Variant<"user_bash_command"> {
	return { kind: "user_bash_command", ...args };
}

export function toTimelineUserToAgent(args: Args<"user_to_agent">): Variant<"user_to_agent"> {
	return { kind: "user_to_agent", ...args };
}

export function toTimelineAgentBlock(args: Args<"agent_block">): Variant<"agent_block"> {
	return { kind: "agent_block", ...args };
}

export function toTimelineSubagentUserKilled(args: Args<"worker_user_killed">): Variant<"worker_user_killed"> {
	return { kind: "worker_user_killed", ...args };
}

export function toTimelineTaskTypeHook(args: Args<"task_start_hook">): Variant<"task_start_hook"> {
	return { kind: "task_start_hook", ...args };
}

export function toTimelineTaskIdleHook(args: Args<"task_idle_hook">): Variant<"task_idle_hook"> {
	return { kind: "task_idle_hook", ...args };
}

export function toTimelineTaskCompleteHook(args: Args<"task_complete_hook">): Variant<"task_complete_hook"> {
	return { kind: "task_complete_hook", ...args };
}

export function toTimelineTaskTreeDirty(args: Args<"task_tree_dirty">): Variant<"task_tree_dirty"> {
	return { kind: "task_tree_dirty", ...args };
}

export function toTimelineTaskTreeView(args: Args<"task_tree_view">): Variant<"task_tree_view"> {
	return { kind: "task_tree_view", ...args };
}

export function toTimelineTaskUpdate(args: Args<"task_update">): Variant<"task_update"> {
	return { kind: "task_update", ...args };
}

export function toTimelineTaskReassigned(args: Args<"task_reassigned">): Variant<"task_reassigned"> {
	return { kind: "task_reassigned", ...args };
}

export function toTimelineObservation(args: Args<"observation">): Variant<"observation"> {
	return { kind: "observation", ...args };
}

export function toTimelineDetachedProcessExited(
	args: Args<"detached_process_exited">,
): Variant<"detached_process_exited"> {
	return { kind: "detached_process_exited", ...args };
}

export function toTimelineEscalation(args: Args<"escalation">): Variant<"escalation"> {
	return { kind: "escalation", ...args };
}

// Re-export the shared arg/value primitives used by these constructors so callers
// can build `args` without reaching into the renderer module.
export type { AgentAtom, TimelineAttachment, TimelineEntry };
