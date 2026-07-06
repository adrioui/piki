export type ObserverStateName = "idle" | "running";

export interface ObserverTurnEvent {
	forkId: string;
	eventId: string;
	timestamp: string;
	payload: Record<string, unknown>;
}

export interface ObserverForkState {
	state: ObserverStateName;
	runId: string | null;
	pendingEvent: ObserverTurnEvent | null;
}

export function initialObserverForkState(): ObserverForkState {
	return {
		state: "idle",
		runId: null,
		pendingEvent: null,
	};
}

export function queueObserverTurn(state: ObserverForkState, event: ObserverTurnEvent): ObserverForkState {
	if (state.state === "idle") {
		return {
			state: "running",
			runId: event.eventId,
			pendingEvent: null,
		};
	}
	return {
		...state,
		pendingEvent: event,
	};
}

export function completeObserverRun(state: ObserverForkState, runId: string): ObserverForkState {
	if (state.state !== "running" || state.runId !== runId) {
		return state;
	}
	const pendingEvent = state.pendingEvent;
	if (pendingEvent) {
		return {
			state: "running",
			runId: pendingEvent.eventId,
			pendingEvent: null,
		};
	}
	return initialObserverForkState();
}
