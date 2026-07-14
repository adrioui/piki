import type {
	EventEnvelope,
	EventStore,
	ProjectionDefinition,
	ProjectionSnapshot,
	ProjectionView,
	RoleDefinition,
	Signal,
} from "./types.ts";

class ProjectionViewImpl<TEvent extends EventEnvelope> implements ProjectionView<TEvent> {
	private readonly states: Map<string, { state: unknown; lastSequence: number }>;

	constructor(states: Map<string, { state: unknown; lastSequence: number }>) {
		this.states = states;
	}

	get<TState>(name: string): TState | undefined {
		return this.states.get(name)?.state as TState | undefined;
	}

	getLastSequence(name: string): number | undefined {
		return this.states.get(name)?.lastSequence;
	}

	snapshots(): ProjectionSnapshot[] {
		return [...this.states.entries()].map(([name, entry]) => ({
			name,
			state: entry.state,
			lastSequence: entry.lastSequence,
		}));
	}
}

export class ForkedProjectionStore<TEvent extends EventEnvelope = EventEnvelope> {
	private readonly globalDefinitions: ProjectionDefinition<TEvent, unknown>[] = [];
	private readonly forkedDefinitions: ProjectionDefinition<TEvent, unknown>[] = [];
	private readonly states = new Map<string, { state: unknown; lastSequence: number }>();

	registerGlobal<TState>(definition: ProjectionDefinition<TEvent, TState>): void {
		this.globalDefinitions.push(definition as ProjectionDefinition<TEvent, unknown>);
		this.ensureState(definition as ProjectionDefinition<TEvent, unknown>);
	}

	registerForked<TState>(definition: ProjectionDefinition<TEvent, TState>): void {
		this.forkedDefinitions.push(definition as ProjectionDefinition<TEvent, unknown>);
		this.ensureState(definition as ProjectionDefinition<TEvent, unknown>);
	}

	/** Back-compat alias: register a global projection. Matches the old `register` API. */
	register<TState>(definition: ProjectionDefinition<TEvent, TState>): void {
		this.registerGlobal(definition);
	}

	apply(event: TEvent): Signal[] {
		const signals: Signal[] = [];
		for (const definition of [...this.globalDefinitions, ...this.forkedDefinitions]) {
			const current = this.ensureState(definition);
			const newState = definition.reduce(current.state, event);
			this.states.set(definition.name, {
				state: newState,
				lastSequence: event.sequence,
			});
			const extract = (
				definition as ProjectionDefinition<TEvent, unknown> & {
					extractSignals?: (state: unknown, event: TEvent) => Signal[];
				}
			).extractSignals;
			if (typeof extract === "function") {
				signals.push(...extract(newState, event));
			}
		}
		return signals;
	}

	view(): ProjectionView<TEvent> {
		return new ProjectionViewImpl<TEvent>(this.states);
	}

	/** Back-compat alias: read a projection state by name. Matches the old `get` API. */
	get<TState>(name: string): TState | undefined {
		return this.view().get<TState>(name);
	}

	removeFork(_forkId: string): void {}

	private ensureState(definition: ProjectionDefinition<TEvent, unknown>): { state: unknown; lastSequence: number } {
		const existing = this.states.get(definition.name);
		if (existing) return existing;
		const state = typeof definition.initialState === "function" ? definition.initialState() : definition.initialState;
		const entry = { state, lastSequence: 0 };
		this.states.set(definition.name, entry);
		return entry;
	}
}

export class ProjectionStore<TEvent extends EventEnvelope = EventEnvelope> extends ForkedProjectionStore<TEvent> {}

export class DefaultEventSink<TEvent extends EventEnvelope = EventEnvelope> {
	private readonly roles: RoleDefinition<TEvent>[] = [];
	private pending: Promise<void>[] = [];
	private readonly store: EventStore<TEvent>;
	private readonly options: {
		projectionStore: ForkedProjectionStore<TEvent>;
		abortSignal?: AbortSignal;
		onEventApplied?: (event: TEvent) => void;
	};

	constructor(
		store: EventStore<TEvent>,
		options: {
			projectionStore: ForkedProjectionStore<TEvent>;
			abortSignal?: AbortSignal;
			onEventApplied?: (event: TEvent) => void;
		},
	) {
		this.store = store;
		this.options = options;
	}

	async publish(event: TEvent): Promise<void> {
		this.options.projectionStore.apply(event);
		this.options.onEventApplied?.(event);
		if (!event.ephemeral) await this.store.append(event);
		const projections = this.projections();
		for (const role of this.roles) {
			const matches = role.match ? await role.match(event, projections) : true;
			if (!matches) continue;
			const pending = Promise.resolve(
				role.run({
					event,
					projections,
					publish: (next) => this.publish(next),
					emitSignal: (_signal: Signal) => {},
					readSignal: (_type: string) => undefined,
					signal: this.options.abortSignal ?? new AbortController().signal,
				}),
			).then(() => undefined);
			this.pending.push(pending);
		}
	}

	replay(events: readonly TEvent[]): void {
		for (const event of events) this.options.projectionStore.apply(event);
	}

	projections(): ProjectionView<TEvent> {
		return this.options.projectionStore.view();
	}

	async waitForIdle(): Promise<void> {
		const pending = this.pending;
		this.pending = [];
		await Promise.all(pending);
	}

	registerProjection<TState>(definition: ProjectionDefinition<TEvent, TState>): void {
		this.options.projectionStore.registerGlobal(definition);
	}

	registerRole(role: RoleDefinition<TEvent>): void {
		this.roles.push(role);
	}

	dispose(): void {
		this.pending = [];
	}
}

function emptyProjection<TEvent extends EventEnvelope>(
	name: string,
): ProjectionDefinition<TEvent, Record<string, unknown>> {
	return {
		name,
		initialState: {},
		reduce: (state) => state,
	};
}

export function createGoalProjection<TEvent extends EventEnvelope>(): ProjectionDefinition<
	TEvent,
	Record<string, unknown>
> {
	return emptyProjection("Goal");
}

export function createTaskGraphProjection<TEvent extends EventEnvelope>(): ProjectionDefinition<
	TEvent,
	Record<string, unknown>
> {
	return emptyProjection("TaskGraph");
}

export function createCheckpointProjection<TEvent extends EventEnvelope>(): ProjectionDefinition<
	TEvent,
	Record<string, unknown>
> {
	return emptyProjection("Checkpoint");
}

export function createUserMessageResolutionProjection<TEvent extends EventEnvelope>(): ProjectionDefinition<
	TEvent,
	Record<string, unknown>
> {
	return emptyProjection("UserMessageResolution");
}

export function createBuiltinProjections<TEvent extends EventEnvelope>(): ProjectionDefinition<TEvent, unknown>[] {
	return [];
}

export function createBuiltinExtendedProjections<TEvent extends EventEnvelope>(): ProjectionDefinition<
	TEvent,
	unknown
>[] {
	return [];
}

export function createBuiltinWorkers<TEvent extends EventEnvelope>(): RoleDefinition<TEvent>[] {
	return [];
}
