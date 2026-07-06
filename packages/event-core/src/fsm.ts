export interface StateTransition<TState extends string, TEvent extends string, TContext = undefined> {
	from: TState;
	event: TEvent;
	to: TState;
	reduce?: (context: TContext) => TContext;
}

export class StateMachine<TState extends string, TEvent extends string, TContext = undefined> {
	private state: TState;
	private context: TContext;
	private readonly transitions: StateTransition<TState, TEvent, TContext>[];

	constructor(
		initialState: TState,
		initialContext: TContext,
		transitions: StateTransition<TState, TEvent, TContext>[],
	) {
		this.state = initialState;
		this.context = initialContext;
		this.transitions = transitions;
	}

	send(event: TEvent): TState {
		const transition = this.transitions.find(
			(candidate) => candidate.from === this.state && candidate.event === event,
		);
		if (!transition) {
			return this.state;
		}
		if (transition.reduce) {
			this.context = transition.reduce(this.context);
		}
		this.state = transition.to;
		return this.state;
	}

	getState(): TState {
		return this.state;
	}

	getContext(): TContext {
		return this.context;
	}

	// --- G17 enrichment: query/inspection methods. All pure, synchronous, non-mutating. ---

	/** Return current state without mutating. */
	hold(): TState {
		return this.state;
	}

	/** If predicate(currentState), project via handler; else undefined. No mutation. */
	match<T>(predicate: (state: TState) => boolean, handler: (state: TState) => T): T | undefined {
		return predicate(this.state) ? handler(this.state) : undefined;
	}

	/** True iff current state === `state`. */
	is(state: TState): boolean {
		return this.state === state;
	}

	/** True iff a transition exists for the current state + event (send would move). */
	canTransition(event: TEvent): boolean {
		return this.transitions.some((candidate) => candidate.from === this.state && candidate.event === event);
	}

	/** True iff `state` (default: current) has no outgoing transitions (is terminal). */
	isTerminal(state: TState = this.state): boolean {
		return !this.transitions.some((candidate) => candidate.from === state);
	}

	/** All distinct terminal states (states with no outgoing transitions). Deduped. */
	getTerminalStates(): TState[] {
		const allStates = new Set<TState>();
		for (const t of this.transitions) {
			allStates.add(t.from);
			allStates.add(t.to);
		}
		const outgoing = new Set<TState>(this.transitions.map((t) => t.from));
		const terminal: TState[] = [];
		for (const s of allStates) {
			if (!outgoing.has(s)) {
				terminal.push(s);
			}
		}
		return terminal;
	}
}
