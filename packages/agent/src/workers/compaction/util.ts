// packages/agent/src/workers/compaction/util.ts
//
// Localized helpers for the CompactionWorker. Unavoidable boundary casts
// (ambient value, projection fork state, agent status) are confined here so
// handler bodies stay free of `as` spray.

import type { AmbientServiceShape, WorkerReadFn } from "@piki/event-core";
import { Effect } from "effect";
import { AgentStatusProjection, type AgentStatusState } from "../../projections/agent-status.ts";
import { type CompactionConfig, CompactionConfigAmbient } from "../../projections/compaction-config.ts";

/** Read the CompactionConfig ambient value (localizes the `unknown` return). */
export function getCompactionConfig(ambientService: AmbientServiceShape): CompactionConfig {
	return ambientService.getValue(CompactionConfigAmbient) as CompactionConfig;
}

/** Derive the role id for a fork from AgentStatusProjection, or null. */
export function getRoleId(read: WorkerReadFn, forkId: string | null): Effect.Effect<string | null, unknown, unknown> {
	return Effect.gen(function* () {
		if (forkId === null) return null;
		const state = (yield* read(AgentStatusProjection, forkId)) as AgentStatusState | undefined;
		if (state === undefined) return null;
		const agentId = state.agentByForkId.get(forkId);
		if (agentId === undefined) return null;
		const agent = state.agents.get(agentId);
		if (agent === undefined) return null;
		return agent.role == null ? null : String(agent.role);
	});
}

/**
 * Pure compaction sizing. Returns the number of window messages to compact.
 * `softCap <= 0` disables compaction (0 messages). This is a structural
 * placeholder size; the live runner computes the real message cut.
 */
export function computeCompactionSizing(
	windowMessages: ReadonlyArray<unknown>,
	softCap: number,
): { readonly compactedMessageCount: number } {
	if (softCap <= 0) return { compactedMessageCount: 0 };
	return { compactedMessageCount: windowMessages.length };
}
