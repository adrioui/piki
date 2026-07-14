// packages/agent/src/projections/goal.ts
//
// GoalProjection tracks the single active goal and the list of finished goals.

import { defineProjection, type EffectProjectionDefinition } from "@piki/event-core";

export interface GoalRecord {
	readonly goalId: string;
	readonly objective: string;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly evidence?: unknown;
}

export interface GoalState {
	readonly active: GoalRecord | null;
	readonly finished: ReadonlyArray<GoalRecord>;
}

export const GoalProjection: EffectProjectionDefinition<GoalState> = defineProjection()<GoalState>({
	name: "Goal",
	initial: {
		active: null,
		finished: [],
	},
	eventHandlers: {
		goal_started: ({ event, state }) => ({
			...state,
			active: {
				goalId: event.goalId,
				objective: event.objective,
				startedAt: event.timestamp,
			},
		}),
		goal_finished: ({ event, state }) => {
			const active = state.active;
			if (!active || active.goalId !== event.goalId) return state;
			return {
				active: null,
				finished: [
					...state.finished,
					{
						...active,
						finishedAt: event.timestamp,
						evidence: event.evidence,
					},
				],
			};
		},
	},
});
