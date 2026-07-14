import type { EventEnvelope, ProjectionDefinition, ProjectionSnapshot, ProjectionView, Signal } from "./types.ts";

interface ProjectionStateEntry {
	state: unknown;
	lastSequence: number;
}

/**
 * Resolve the initial state from a ProjectionDefinition, supporting both
 * plain values and factory functions (initialState: () => ...).
 */
function resolveInitialState<TState>(definition: { initialState: TState | (() => TState) }): TState {
	const raw = definition.initialState;
	return typeof raw === "function" ? (raw as () => TState)() : raw;
}

/**
 * Projection store that applies events to registered projections synchronously.
 *
 * Supports:
 * - `reads`/`writes` dependency metadata (for topological ordering)
 * - `extractSignals` to emit signals after each reduce
 * - `initialState` as value or factory
 * - Replay/hydration by re-applying a sequence of events
 */
export class ProjectionStore<TEvent extends EventEnvelope = EventEnvelope> implements ProjectionView<TEvent> {
	private readonly definitions = new Map<string, ProjectionDefinition<TEvent, unknown>>();
	private readonly states = new Map<string, ProjectionStateEntry>();
	/** Signals emitted during the last apply() call, keyed by projection name. */
	private readonly pendingSignals: Signal[] = [];

	/** Ordered projection names (topological order by reads/writes if available). */
	private orderedNames: string[] = [];

	register<TState>(definition: ProjectionDefinition<TEvent, TState>): void {
		this.definitions.set(definition.name, definition as ProjectionDefinition<TEvent, unknown>);
		this.states.set(definition.name, {
			state: resolveInitialState(definition as ProjectionDefinition<EventEnvelope, TState>),
			lastSequence: 0,
		});
		this.recomputeOrder();
	}

	/** Recompute the topological order of projections based on reads/writes. */
	private recomputeOrder(): void {
		const names = Array.from(this.definitions.keys());
		const deps = new Map<string, Set<string>>();
		for (const [name, def] of this.definitions) {
			const reads = new Set(def.reads ?? []);
			// Also depend on anything this projection writes to (if another reads from it)
			for (const [otherName, otherDef] of this.definitions) {
				if (otherName === name) continue;
				if ((otherDef.writes ?? []).includes(name)) {
					reads.add(otherName);
				}
			}
			deps.set(name, reads);
		}

		// Kahn's algorithm for topological sort
		const inDegree = new Map<string, number>();
		for (const name of names) {
			inDegree.set(name, deps.get(name)?.size ?? 0);
		}
		const ordered: string[] = [];
		const queue = names.filter((name) => (inDegree.get(name) ?? 0) === 0).sort();
		while (queue.length > 0) {
			const current = queue.shift()!;
			ordered.push(current);
			for (const name of names) {
				if (name === current) continue;
				const d = deps.get(name);
				if (d?.has(current)) {
					d.delete(current);
					const deg = (inDegree.get(name) ?? 0) - 1;
					inDegree.set(name, deg);
					if (deg === 0) queue.push(name);
				}
			}
		}
		// Any remaining names (cyclic or unresolved) are appended in registration order
		for (const name of names) {
			if (!ordered.includes(name)) ordered.push(name);
		}
		this.orderedNames = ordered;
	}

	apply(event: TEvent): Signal[] {
		this.pendingSignals.length = 0;
		for (const name of this.orderedNames) {
			const definition = this.definitions.get(name);
			if (!definition) continue;
			const current = this.states.get(name);
			const currentState = current?.state ?? resolveInitialState(definition);
			const nextState = definition.reduce(currentState, event);
			this.states.set(name, {
				state: nextState,
				lastSequence: event.sequence,
			});
			if (definition.extractSignals) {
				const signals = definition.extractSignals(nextState, event);
				for (const sig of signals) {
					this.pendingSignals.push(sig);
				}
			}
		}
		return [...this.pendingSignals];
	}

	/** Replay a sequence of events to rebuild projection state (hydration). */
	replay(events: readonly TEvent[]): void {
		for (const [name, def] of this.definitions) {
			this.states.set(name, {
				state: resolveInitialState(def),
				lastSequence: 0,
			});
		}
		for (const event of events) {
			this.apply(event);
		}
	}

	get<TState>(name: string): TState | undefined {
		return this.states.get(name)?.state as TState | undefined;
	}

	getLastSequence(name: string): number | undefined {
		return this.states.get(name)?.lastSequence;
	}

	snapshots(): ProjectionSnapshot[] {
		return Array.from(this.states.entries()).map(([name, value]) => ({
			name,
			state: value.state,
			lastSequence: value.lastSequence,
		}));
	}

	/** Get the ordered list of projection names (topological order). */
	getOrderedNames(): string[] {
		return [...this.orderedNames];
	}
}
