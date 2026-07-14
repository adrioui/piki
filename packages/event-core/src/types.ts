export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
	id: string;
	stream: string;
	sequence: number;
	type: TType;
	timestamp: string;
	sessionId?: string;
	source?: string;
	/** Coordination-only events update projections and roles but are not persisted to the event store. */
	ephemeral?: boolean;
	payload: TPayload;
}

export interface EventListOptions {
	afterSequence?: number;
	limit?: number;
}

export interface EventStore<TEvent extends EventEnvelope = EventEnvelope> {
	append(event: TEvent): Promise<void> | void;
	appendMany(events: readonly TEvent[]): Promise<void> | void;
	list(options?: EventListOptions): Promise<TEvent[]> | TEvent[];
	/** Rewrite the entire event log (used during compaction or migration). */
	rewrite?(events: readonly TEvent[]): Promise<void> | void;
	/** Truncate events after a given sequence (used for rollback). */
	truncate?(afterSequence: number): Promise<void> | void;
}

/**
 * A signal is a typed message that roles can emit and other roles can listen for.
 * Unlike events, signals are not persisted — they are ephemeral coordination messages
 * that flow through the runtime's signal bus.
 *
 * Signals are used for inter-projection and inter-role communication
 * (e.g. TaskGraph/taskCreated, TaskGraph/taskCompleted).
 */
export interface Signal<TType extends string = string, TPayload = unknown> {
	type: TType;
	payload: TPayload;
}

export interface SignalDefinition<TType extends string = string, _TPayload = unknown> {
	type: TType;
	description?: string;
}

/**
 * Creates a typed signal definition.
 */
export function createSignal<TType extends string, TPayload = unknown>(
	type: TType,
	description?: string,
): SignalDefinition<TType, TPayload> {
	return { type, description };
}

/**
 * Signal bus for ephemeral inter-role and inter-projection communication.
 * Signals are not persisted — they flow through the runtime and are
 * available for the duration of a turn or until explicitly cleared.
 */
export interface SignalBus {
	/** Dispatch a signal to all listeners. */
	dispatch(signal: Signal): void;
	/** Read the most recent signal of a given type. */
	read(type: string): Signal | undefined;
	/** Clear all signals (called at the start of each turn). */
	clear(): void;
	/** Subscribe to signals of a specific type. Returns an unsubscribe function. */
	on(type: string, listener: (signal: Signal) => void): () => void;
}

/**
 * Projection definition with explicit reads/writes dependencies and signal emissions.
 *
 * This follows the pattern where each projection declares which other projections
 * it reads from and writes to, enabling topological ordering and cycle detection.
 */
export interface ProjectionDefinition<TEvent extends EventEnvelope = EventEnvelope, TState = unknown> {
	name: string;
	/** Projections this one reads from (for dependency ordering). */
	reads?: string[];
	/** Projections this one writes to (for dependency ordering). */
	writes?: string[];
	/** Signals emitted by this projection's reduce function. */
	signals?: SignalDefinition[];
	/** Initial state factory (supports factory functions for lazy initialization). */
	initialState: TState | (() => TState);
	/** Pure reducer that produces next state from current state + event. */
	reduce: (state: TState, event: TEvent) => TState;
	/**
	 * Optional signal extraction — runs after reduce and returns signals
	 * that should be emitted to the signal bus.
	 */
	extractSignals?: (state: TState, event: TEvent) => Signal[];
}

export interface ProjectionSnapshot<TState = unknown> {
	name: string;
	state: TState;
	lastSequence: number;
}

export interface ProjectionView<_TEvent extends EventEnvelope = EventEnvelope> {
	get<TState>(name: string): TState | undefined;
	getLastSequence(name: string): number | undefined;
	snapshots(): ProjectionSnapshot[];
}

export interface RoleContext<TEvent extends EventEnvelope = EventEnvelope> {
	event: TEvent;
	projections: ProjectionView<TEvent>;
	publish: (event: TEvent) => Promise<void>;
	/** Emit a signal to the signal bus. */
	emitSignal: (signal: Signal) => void;
	/** Read a signal by type (returns the most recent signal of that type). */
	readSignal: (type: string) => Signal | undefined;
	signal: AbortSignal;
}

export interface RoleDefinition<TEvent extends EventEnvelope = EventEnvelope> {
	name: string;
	/** Events this role reacts to (optional; if omitted, reacts to all). */
	match?: (event: TEvent, projections: ProjectionView<TEvent>) => boolean | Promise<boolean>;
	/** Signals this role listens for (optional). */
	listenSignals?: string[];
	/** The role's execution function. */
	run: (context: RoleContext<TEvent>) => Promise<void> | void;
	/** Per-key concurrency serialization for preventing race conditions. */
	concurrencyKey?: (event: TEvent) => string;
}

/**
 * The EventSink is the central event bus that persists events, applies
 * projections synchronously, dispatches signals, and runs roles asynchronously.
 *
 * Two-phase processing model:
 * - Phase 1 (synchronous): Projections (deterministic state reduction)
 * - Phase 2 (asynchronous): Workers/Roles (side effects, LLM calls)
 */
export interface EventSink<TEvent extends EventEnvelope = EventEnvelope> {
	/** Publish an event: apply projections → persist durable events → dispatch signals → run roles. */
	publish(event: TEvent): Promise<void>;
	/** Replay events from the store to rebuild projection state (hydration on startup). */
	replay(events: readonly TEvent[]): void;
	/** Get the current projection view. */
	projections(): ProjectionView<TEvent>;
	/** Wait for all async roles to settle. */
	waitForIdle(): Promise<void>;
	/** Register a projection definition. */
	registerProjection<TState>(definition: ProjectionDefinition<TEvent, TState>): void;
	/** Register a role definition. */
	registerRole(role: RoleDefinition<TEvent>): void;
	/** Dispose the sink and abort all in-flight roles. */
	dispose(): void;
}
