import type { ManagedRuntime } from "effect";
import { Effect } from "effect";
import { ProjectionStore } from "./projection.ts";
import { InMemorySignalBus, RoleHost } from "./role.ts";
import { HydrationContext } from "./runtime/hydration-context.ts";
import { ProjectionBus } from "./runtime/projection-bus.ts";
import type { FoundationRequirements } from "./runtime/runtime.ts";
import type {
	EventEnvelope,
	EventSink,
	EventStore,
	ProjectionDefinition,
	ProjectionSnapshot,
	ProjectionView,
	RoleDefinition,
	Signal,
} from "./types.ts";

interface WritableProjectionStore<TEvent extends EventEnvelope = EventEnvelope> extends ProjectionView<TEvent> {
	register<TState>(definition: ProjectionDefinition<TEvent, TState>): void;
	apply(event: TEvent): Signal[];
	replay(events: readonly TEvent[]): void;
	snapshots(): ProjectionSnapshot[];
}

export interface DefaultEventSinkOptions<TEvent extends EventEnvelope = EventEnvelope> {
	onEventApplied?: (event: TEvent) => void;
	/** Optional projection store override. If not provided, a default ProjectionStore is created. */
	projectionStore?: WritableProjectionStore<TEvent>;
	/** Optional Effect runtime. When present, replay() sets the HydrationContext flag during hydration. */
	effectRuntime?: ManagedRuntime.ManagedRuntime<FoundationRequirements, never>;
}

/**
 * Default EventSink implementation.
 *
 * Implements a two-phase processing model:
 * - Phase 1 (synchronous): Apply projections → persist durable event → extract signals
 * - Phase 2 (asynchronous): Dispatch signals → run matching roles
 *
 * On startup, call `replay()` with the event log to hydrate projection state
 * from the persisted event store. This makes projections the authoritative
 * source of truth — the entire session state can be reconstructed from the
 * event log alone.
 */
export class DefaultEventSink<TEvent extends EventEnvelope = EventEnvelope> implements EventSink<TEvent> {
	private readonly store: EventStore<TEvent>;
	private readonly _projections: WritableProjectionStore<TEvent>;
	private readonly roleHost: RoleHost<TEvent>;
	private readonly signalBus: InMemorySignalBus;
	private readonly onEventApplied?: (event: TEvent) => void;
	private readonly effectRuntime?: ManagedRuntime.ManagedRuntime<FoundationRequirements, never>;
	private readonly controller = new AbortController();
	private sequence = 0;
	private publishChain: Promise<void> = Promise.resolve();

	constructor(store: EventStore<TEvent>, options: DefaultEventSinkOptions<TEvent> = {}) {
		this.store = store;
		this.onEventApplied = options.onEventApplied;
		this.effectRuntime = options.effectRuntime;
		this._projections = options.projectionStore ?? new ProjectionStore<TEvent>();
		this.signalBus = new InMemorySignalBus();
		this.roleHost = new RoleHost<TEvent>({
			projections: this._projections,
			publish: async (event) => {
				await this.publish(event);
			},
			signals: this.signalBus,
			signal: this.controller.signal,
		});
	}

	async publish(event: TEvent): Promise<void> {
		const publishTask = this.publishChain.then(async () => {
			if (this.controller.signal.aborted) return;
			const appliedEvent =
				event.sequence > this.sequence ? event : ({ ...event, sequence: this.sequence + 1 } as TEvent);

			// Phase 1: apply projections, then persist durable events.
			this.sequence = Math.max(this.sequence, appliedEvent.sequence);
			const signals = this._projections.apply(appliedEvent);
			this.onEventApplied?.(appliedEvent);
			if (!appliedEvent.ephemeral) {
				await this.store.append(appliedEvent);
			}
			if (this.effectRuntime && signals.length > 0) {
				await this.effectRuntime.runPromise(
					Effect.gen(function* () {
						const projectionBus = yield* ProjectionBus;
						for (const signal of signals) {
							yield* projectionBus.queueSignal(signal.type, signal.payload, undefined);
						}
						yield* projectionBus.flushSignalQueue();
					}),
				);
			}

			// Phase 2: Run roles asynchronously
			void this.roleHost.handle(appliedEvent, signals).catch(() => {
				// Role errors are non-fatal; they don't break the event pipeline
			});
		});
		this.publishChain = publishTask.catch(() => {});
		await publishTask;
	}

	replay(events: readonly TEvent[]): void {
		this._projections.replay(events);
		for (const event of events) {
			this.sequence = Math.max(this.sequence, event.sequence);
		}
		// When an Effect runtime is provided, mark the hydration flag during replay.
		// Backwards compatible: no runtime → flag is never set, existing behavior unchanged.
		// Fire-and-forget; replay() stays synchronous from the caller's perspective.
		const runtime = this.effectRuntime;
		if (runtime) {
			void runtime
				.runPromise(
					Effect.gen(function* () {
						const ctx = yield* HydrationContext;
						yield* ctx.setHydrating(true);
						yield* ctx.setHydrating(false);
					}),
				)
				.catch(() => {
					// Hydration flag errors are non-fatal; replay already completed synchronously.
				});
		}
	}

	projections(): ProjectionView<TEvent> {
		return this._projections;
	}

	registerProjection<TState>(definition: ProjectionDefinition<TEvent, TState>): void {
		this._projections.register(definition);
	}

	registerRole(role: RoleDefinition<TEvent>): void {
		this.roleHost.register(role);
	}

	async waitForIdle(): Promise<void> {
		await this.roleHost.waitForIdle();
	}

	getSequence(): number {
		return this.sequence;
	}

	getSignalBus(): InMemorySignalBus {
		return this.signalBus;
	}

	dispose(): void {
		this.controller.abort();
		this.signalBus.clear();
	}
}
