import { createSignal, type EventEnvelope, type ProjectionDefinition, type Signal } from "../types.ts";

type Bag = Record<string, unknown>;

function payload(event: EventEnvelope): Bag {
	return (event.payload ?? {}) as Bag;
}

export type GoalStatus = "pending" | "running" | "completed" | "incomplete";

export interface GoalState {
	status: GoalStatus;
	text: string;
	goalId: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	reason: string | null;
}

export const GoalSignals = {
	statusChanged: createSignal("Goal/statusChanged", "Emitted when the goal status transitions"),
} as const;

export function createGoalProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	GoalState
> {
	return {
		name: "Goal",
		reads: [],
		writes: [],
		signals: [GoalSignals.statusChanged],
		initialState: (): GoalState => ({
			status: "pending",
			text: "",
			goalId: null,
			startedAt: null,
			finishedAt: null,
			reason: null,
		}),
		reduce: reduceGoal,
		extractSignals: extractGoalSignals,
	};
}

function reduceGoal(state: GoalState, event: EventEnvelope): GoalState {
	const p = payload(event);
	switch (event.type) {
		case "goal_started": {
			const goalId = typeof p.goalId === "string" ? p.goalId : null;
			return {
				...state,
				status: "running",
				text: typeof p.text === "string" ? p.text : state.text,
				goalId,
				startedAt: event.timestamp,
				finishedAt: null,
				reason: null,
			};
		}
		case "goal_finished": {
			const success = p.success === true;
			return {
				...state,
				status: success ? "completed" : "incomplete",
				finishedAt: event.timestamp,
				reason: success ? null : typeof p.reason === "string" ? p.reason : null,
			};
		}
		default:
			return state;
	}
}

function extractGoalSignals(state: GoalState, event: EventEnvelope): Signal[] {
	if (event.type === "goal_started" && state.startedAt === event.timestamp) {
		return [
			{
				type: GoalSignals.statusChanged.type,
				payload: { goalId: state.goalId, status: "running", previous: "pending" },
			},
		];
	}
	if (event.type === "goal_finished" && state.finishedAt === event.timestamp) {
		return [
			{
				type: GoalSignals.statusChanged.type,
				payload: { goalId: state.goalId, status: state.status, previous: "running" },
			},
		];
	}
	return [];
}
