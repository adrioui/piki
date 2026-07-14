import type { EventEnvelope, ProjectionView, RoleContext, RoleDefinition, Signal, SignalBus } from "./types.ts";

export interface RoleHostOptions<TEvent extends EventEnvelope = EventEnvelope> {
	projections: ProjectionView<TEvent>;
	publish: (event: TEvent) => Promise<void>;
	/** Optional signal bus for inter-role communication. */
	signals?: SignalBus;
	signal?: AbortSignal;
}

/**
 * Role host that runs roles asynchronously after events are applied to projections.
 *
 * This is Phase 2 of the two-phase processing model:
 * - Phase 1 (synchronous): Projections reduce events to state
 * - Phase 2 (asynchronous): Roles react to events, read projections, publish new events
 *
 * Roles are serialized per concurrency key to prevent race conditions.
 */
export class RoleHost<TEvent extends EventEnvelope = EventEnvelope> {
	private readonly roles: RoleDefinition<TEvent>[] = [];
	private readonly inflightByKey = new Map<string, Promise<void>>();
	private readonly matching = new Set<Promise<void>>();
	private readonly projections: ProjectionView<TEvent>;
	private readonly publishEvent: (event: TEvent) => Promise<void>;
	private readonly signalBus: SignalBus;
	private readonly signal: AbortSignal;
	private readonly failures: unknown[] = [];

	constructor(options: RoleHostOptions<TEvent>) {
		this.projections = options.projections;
		this.publishEvent = options.publish;
		this.signalBus = options.signals ?? new InMemorySignalBus();
		this.signal = options.signal ?? new AbortController().signal;
	}

	register(role: RoleDefinition<TEvent>): void {
		this.roles.push(role);
	}

	/** Get the signal bus (for external access to emitted signals). */
	getSignalBus(): SignalBus {
		return this.signalBus;
	}

	async handle(event: TEvent, extractedSignals: Signal[] = []): Promise<void> {
		// Signals are ephemeral per-event — clear before dispatch so roles see only signals emitted for this specific event
		this.signalBus.clear();
		// Dispatch signals extracted by projections
		for (const sig of extractedSignals) {
			this.signalBus.dispatch(sig);
		}

		for (const role of this.roles) {
			if (this.signal.aborted) return;
			let matches = true;
			if (role.match) {
				const matchPromise = Promise.resolve(role.match(event, this.projections)).then((result) => {
					matches = result;
				});
				this.matching.add(matchPromise);
				try {
					await matchPromise;
				} finally {
					this.matching.delete(matchPromise);
				}
			}
			if (!matches) continue;
			// Also check if role listens for specific signals
			if (role.listenSignals && role.listenSignals.length > 0) {
				const hasMatchingSignal = role.listenSignals.some((sigType) => this.signalBus.read(sigType) !== undefined);
				if (!hasMatchingSignal) continue;
			}
			const key = role.concurrencyKey ? `${role.name}:${role.concurrencyKey(event)}` : role.name;
			const previous = this.inflightByKey.get(key) ?? Promise.resolve();
			const next = previous
				.catch(() => {})
				.then(async () => {
					if (this.signal.aborted) return;
					const context: RoleContext<TEvent> = {
						event,
						projections: this.projections,
						publish: this.publishEvent,
						emitSignal: (sig: Signal) => this.signalBus.dispatch(sig),
						readSignal: (type: string) => this.signalBus.read(type),
						signal: this.signal,
					};
					try {
						await role.run(context);
					} catch (error) {
						this.failures.push(error);
					}
				})
				.finally(() => {
					if (this.inflightByKey.get(key) === next) {
						this.inflightByKey.delete(key);
					}
				});
			this.inflightByKey.set(key, next);
		}
	}

	async waitForIdle(): Promise<void> {
		while (this.matching.size > 0) {
			await Promise.allSettled([...this.matching]);
		}
		while (this.inflightByKey.size > 0) {
			await Promise.allSettled([...this.inflightByKey.values()]);
		}
		if (this.failures.length > 0) {
			const failures = this.failures.splice(0);
			throw new AggregateError(failures, "One or more roles failed");
		}
	}
}

/**
 * In-memory signal bus for ephemeral inter-role communication.
 * Signals are not persisted — they are coordination messages that flow
 * through the runtime and are available for the duration of a turn.
 */
export class InMemorySignalBus implements SignalBus {
	private readonly signals = new Map<string, Signal>();
	private readonly listeners = new Map<string, Array<(signal: Signal) => void>>();

	dispatch(signal: Signal): void {
		this.signals.set(signal.type, signal);
		const listeners = this.listeners.get(signal.type);
		if (listeners) {
			for (const listener of listeners) {
				listener(signal);
			}
		}
	}

	read(type: string): Signal | undefined {
		return this.signals.get(type);
	}

	clear(): void {
		this.signals.clear();
	}

	on(type: string, listener: (signal: Signal) => void): () => void {
		if (!this.listeners.has(type)) {
			this.listeners.set(type, []);
		}
		this.listeners.get(type)?.push(listener);
		return () => {
			const arr = this.listeners.get(type);
			if (arr) {
				const idx = arr.indexOf(listener);
				if (idx >= 0) arr.splice(idx, 1);
			}
		};
	}
}
