export function defineFSM<
	TStates extends Record<string, new (args: any) => { _tag: string }>,
	TTransitions extends Record<string, readonly string[]>,
>(states: TStates, transitions: TTransitions) {
	const stateNames = Object.keys(states);

	const transition = (from: { _tag: string } & Record<string, any>, target: string, updates?: Record<string, any>) => {
		const fromTag = from._tag;
		const validTargets = transitions[fromTag] ?? [];
		if (!validTargets.includes(target)) {
			const allowed = validTargets.length > 0 ? validTargets.join(", ") : "none";
			throw new Error(`Invalid FSM transition: "${fromTag}" -> "${target}". Allowed targets: ${allowed}`);
		}
		const TargetClass = states[target];
		return new TargetClass({ ...from, ...updates });
	};

	const hold = (from: { _tag: string } & Record<string, any>, updates?: Record<string, any>) => {
		const CurrentClass = states[from._tag];
		return new CurrentClass({ ...from, ...updates });
	};

	const match = <T>(state: { _tag: string }, handlers: Record<string, (state: any) => T>): T => {
		return handlers[state._tag](state);
	};

	const is = (state: { _tag: string }, tag: string): boolean => state._tag === tag;

	const canTransition = (from: string, to: string): boolean => (transitions[from] ?? []).includes(to);

	const isTerminal = (state: string): boolean => (transitions[state] ?? []).length === 0;

	const getTerminalStates = (): string[] => stateNames.filter((state) => isTerminal(state));

	return {
		states: stateNames,
		stateClasses: states,
		transitions,
		transition,
		hold,
		match,
		is,
		canTransition,
		isTerminal,
		getTerminalStates,
	};
}
