import type { SessionEntry } from "../../../../src/core/session-manager.ts";

/** A single tool call the agent makes (or is expected to make). */
export interface ParityToolCall {
	name: string;
	args: Record<string, unknown>;
}

/**
 * Expected permission outcome for a tool call, asserted via `evaluatePermission`
 * (Channel B — the authoritative permission channel, since `AgentSessionEvent`
 * has no structured permission event).
 */
export interface ParityPermissionExpectation {
	tool: ParityToolCall;
	permitted: boolean;
	/** Required when `permitted === false`. Exact reason string. */
	reason?: string;
}

/**
 * ATIF alpha22 expectations, evaluated AFTER non-deterministic fields
 * (ids, timestamps, usage) are stripped from the exported trajectory.
 */
export interface ParityAtifExpectation {
	/** Ordered step `source`-ish markers or step type tags to assert presence. */
	stepTypes?: string[];
	/** Exact `final_metrics.total_steps` (counts ALL message entries incl. leading user). */
	totalSteps?: number;
	/** Number of `subagent_trajectories` entries. */
	subagentTrajectoryCount?: number;
	/** Whether a `forkId` is set on user+assistant steps (S8). */
	forkIdPresent?: boolean;
	/** Whether `llm_call_count` is present on agent steps (S7). */
	llmCallCountPresent?: boolean;
	/** Whether an agent step carries tool calls. */
	hasAssistantWithToolCalls?: boolean;
}

/**
 * A canonical task encoded as a recorded-mock replay script (what `mag` would
 * have emitted) plus expected parity outcomes.
 */
export interface ParityFixture {
	id: string;
	description: string;
	prompt: string;
	/** Tool names active for the run (drives tool execution + known-tools). */
	toolNames: string[];
	/** Faux assistant responses replayed through the Faux Provider. */
	responses: import("@piki/ai/compat").FauxResponseStep[];
	/** Permission outcomes asserted via `evaluatePermission`. */
	expectedPermissions: ParityPermissionExpectation[];
	/** ATIF expectations (skipped if absent). */
	expectedAtif?: ParityAtifExpectation;
	/** Harness/replay options. */
	options?: {
		cwd?: string;
		scratchpadPath?: string;
		disableShellSafeguards?: boolean;
		/** Independent cwd write-boundary toggle (alpha22 `--disable-cwd-safeguards`). */
		disableCwdSafeguards?: boolean;
	};
	/**
	 * For fork-spawn scenarios: a builder that exercises the real
	 * `WorkerSession` fork-entry capture (S5/S7/S8) and returns per-fork
	 * entries keyed by forkId. When present, the runner skips the leader
	 * harness and builds ATIF from these entries directly.
	 */
	buildForkEntries?: () => Map<string, SessionEntry[]> | Promise<Map<string, SessionEntry[]>>;
}
