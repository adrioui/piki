// Projection-bus signal-queue flush + ambient dispatch.
// Event-driven layer that applies events through registered handlers, emits
// signals, and dispatches ambient changes in dependency-topological order.
import { Context, Data, Effect, Layer, Ref } from "effect";
import type { EventEnvelope, Signal } from "../types.ts";
import { FrameworkErrorReporter } from "./framework-error.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max iterations of the signal-flush loop before warning. */
const MAX_SIGNAL_FLUSH_ITERATIONS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectionEventHandler {
	readonly name: string;
	readonly eventTypes: readonly string[];
	readonly handler: (event: EventEnvelope) => Effect.Effect<void>;
}

export interface ProjectionSignalHandler {
	readonly name: string;
	readonly handler: (value: Signal["payload"], sourceState: unknown) => Effect.Effect<void>;
}

export interface ProjectionAmbientHandler {
	readonly name: string;
	readonly handler: (value: unknown) => Effect.Effect<void>;
}

interface QueuedSignal {
	readonly signalName: string;
	readonly value: unknown;
	readonly sourceState: unknown;
	readonly eventTimestamp: number;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ProjectionBusCycleError extends Data.TaggedError("ProjectionBusCycleError")<{
	readonly nodes: readonly string[];
	readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
}> {}

export class ProjectionBusMissingProjectionError extends Data.TaggedError("ProjectionBusMissingProjectionError")<{
	readonly projectionName: string;
}> {}

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

export interface ProjectionBusShape {
	/** Register an event handler (bundles name, eventTypes, handler fn). */
	readonly register: (handler: ProjectionEventHandler) => Effect.Effect<void>;
	/** Register a signal handler keyed by signalName, owned by a projection. */
	readonly registerSignalHandler: (signalName: string, handler: ProjectionSignalHandler) => Effect.Effect<void>;
	/** Register an ambient handler keyed by ambientName, owned by a projection. */
	readonly registerAmbientHandler: (ambientName: string, handler: ProjectionAmbientHandler) => Effect.Effect<void>;
	/** Enqueue a signal for later flush. */
	readonly queueSignal: (signalName: string, value: unknown, sourceState: unknown) => Effect.Effect<void>;
	/** Declare that `name` depends on `dependsOn` in the dispatch-order graph. */
	readonly registerDependency: (name: string, dependsOn: string) => Effect.Effect<void>;
	/** Validate the dependency graph has no cycles. Dies with ProjectionBusCycleError on cycle. */
	readonly validateNoCycles: () => Effect.Effect<void>;
	/** Apply an event through the bus: dispatch event handlers (top-sorted), then flush signal queue. */
	readonly processEvent: (event: EventEnvelope) => Effect.Effect<void>;
	/** Dispatch ambient handlers for the given ambientName, then flush signal queue. */
	readonly processAmbientChange: (ambientName: string, value: unknown) => Effect.Effect<void>;
	/** Drain the signal queue now. Safe to call multiple times. */
	readonly flushSignalQueue: () => Effect.Effect<void>;
	/** Read projection state by name (requires registerStateGetter — deferred). */
	readonly getProjectionState: (name: string) => Effect.Effect<unknown>;
}

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export const ProjectionBus = Context.GenericTag<ProjectionBusShape>("ProjectionBus");

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

/** Kahn's topological sort over handler names using the dependency graph.
 *  Returns input order on cyclic graphs (best-effort; cycle detection is
 *  `validateNoCycles`'s job). */
function topologicalSort(handlerNames: readonly string[], dependencyGraph: Map<string, Set<string>>): string[] {
	const names = new Set(handlerNames);
	const inDegree = new Map<string, number>();
	const edges = new Map<string, string[]>();
	for (const name of names) {
		inDegree.set(name, 0);
		edges.set(name, []);
	}
	for (const name of names) {
		const deps = dependencyGraph.get(name) ?? new Set<string>();
		for (const dep of deps) {
			if (names.has(dep)) {
				edges.get(dep)!.push(name);
				inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
			}
		}
	}
	const queue: string[] = [];
	for (const [name, degree] of inDegree) {
		if (degree === 0) queue.push(name);
	}
	const sorted: string[] = [];
	while (queue.length > 0) {
		const name = queue.shift()!;
		sorted.push(name);
		for (const dependent of edges.get(name) ?? []) {
			const newDegree = (inDegree.get(dependent) ?? 0) - 1;
			inDegree.set(dependent, newDegree);
			if (newDegree === 0) queue.push(dependent);
		}
	}
	if (sorted.length !== names.size) {
		return [...handlerNames];
	}
	return sorted;
}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

/**
 * Live ProjectionBus layer. Requires FrameworkErrorReporter for failure isolation.
 * Event-driven layer that applies an event through the bus: dispatches the
 * matching event handlers (topologically sorted by dependency), then flushes
 * the signal queue.
 *
 * NOTE: Uses `Layer.effect` (NOT `Layer.scoped` — absent in effect@4.0.0-beta.93).
 * Ref.make(...) returns Effect<Ref<...>, never, never> (no Scope needed), so
 * `Layer.effect` auto-strips Scope from requirements.
 */
export const ProjectionBusLive = Layer.effect(
	ProjectionBus,
	Effect.gen(function* () {
		const reporter = yield* FrameworkErrorReporter;
		// Five Refs for mutable handler/queue state
		const eventHandlersRef = yield* Ref.make<ProjectionEventHandler[]>([]);
		const signalHandlersRef = yield* Ref.make<Map<string, ProjectionSignalHandler[]>>(new Map());
		const ambientHandlersRef = yield* Ref.make<Map<string, ProjectionAmbientHandler[]>>(new Map());
		const signalQueueRef = yield* Ref.make<QueuedSignal[]>([]);
		const dependencyGraphRef = yield* Ref.make<Map<string, Set<string>>>(new Map());
		// Plain map for state getters (not a Ref — synchronous access via Effect.sync)
		const stateGetters = new Map<string, { getter: () => unknown; isForked: boolean }>();
		// Handler-order caches (invalidated on register)
		let cachedEventHandlerOrder: string[] | null = null;
		const signalHandlerOrderCache = new Map<string, string[]>();

		// Event timestamp carried per queued signal (replaces mutable closure).
		const currentEventTimestampRef = yield* Ref.make(Date.now());

		// Flush loop — drains signalQueueRef up to MAX_SIGNAL_FLUSH_ITERATIONS times.
		// Drains the signal queue up to MAX_SIGNAL_FLUSH_ITERATIONS.
		const flushSignalQueue = Effect.gen(function* () {
			let iterations = 0;
			const graph = yield* Ref.get(dependencyGraphRef);
			while (true) {
				const queue = yield* Ref.getAndSet(signalQueueRef, [] as QueuedSignal[]);
				if (queue.length === 0) break;
				if (iterations++ >= MAX_SIGNAL_FLUSH_ITERATIONS) {
					yield* Effect.logWarning(
						`Signal flush exceeded ${MAX_SIGNAL_FLUSH_ITERATIONS} iterations, possible infinite loop`,
					);
					break;
				}
				const signalHandlers = yield* Ref.get(signalHandlersRef);
				for (const { signalName, value, sourceState, eventTimestamp } of queue) {
					const timestampedValue = {
						...(value as object),
						timestamp: eventTimestamp,
					} as Signal["payload"];
					const handlers = signalHandlers.get(signalName) ?? [];
					if (handlers.length === 0) continue;
					let sortedNames = signalHandlerOrderCache.get(signalName);
					if (!sortedNames) {
						const handlerNames = handlers.map((h) => h.name);
						sortedNames = topologicalSort(handlerNames, graph);
						signalHandlerOrderCache.set(signalName, sortedNames);
					}
					const nameToHandler = new Map(handlers.map((h) => [h.name, h]));
					for (const name of sortedNames) {
						const handlerItem = nameToHandler.get(name);
						if (handlerItem) {
							yield* handlerItem.handler(timestampedValue, sourceState).pipe(
								Effect.catchAllCause((cause: unknown) =>
									reporter.report({
										_tag: "ProjectionSignalHandlerError",
										projectionName: name,
										signalName,
										cause,
									} as never),
								),
							);
						}
					}
				}
			}
		});

		return {
			register: (handler: ProjectionEventHandler) =>
				Effect.gen(function* () {
					yield* Ref.update(eventHandlersRef, (handlers) => [...handlers, handler]);
					cachedEventHandlerOrder = null;
				}),

			registerSignalHandler: (signalName: string, handler: ProjectionSignalHandler) =>
				Effect.gen(function* () {
					// Derive source projection from signal name (standard pattern)
					const sourceProjection = signalName.split("/")[0] ?? handler.name;
					// Skip self-dependency to avoid spurious cycle edges
					if (sourceProjection !== handler.name) {
						yield* Ref.update(dependencyGraphRef, (graph) => {
							const deps = graph.get(handler.name) ?? new Set<string>();
							deps.add(sourceProjection);
							return new Map(graph).set(handler.name, deps);
						});
					}
					// Register the handler
					yield* Ref.update(signalHandlersRef, (map) => {
						const existing = map.get(signalName) ?? [];
						return new Map(map).set(signalName, [...existing, handler]);
					});
					signalHandlerOrderCache.delete(signalName);
				}),

			registerAmbientHandler: (ambientName: string, handler: ProjectionAmbientHandler) =>
				Effect.gen(function* () {
					yield* Ref.update(ambientHandlersRef, (map) => {
						const existing = map.get(ambientName) ?? [];
						return new Map(map).set(ambientName, [...existing, handler]);
					});
				}),

			queueSignal: (signalName: string, value: unknown, sourceState: unknown) =>
				Effect.gen(function* () {
					const eventTimestamp = yield* Ref.get(currentEventTimestampRef);
					yield* Ref.update(signalQueueRef, (queue) => [
						...queue,
						{ signalName, value, sourceState, eventTimestamp },
					]);
				}),

			registerDependency: (name: string, dependsOn: string) =>
				Effect.gen(function* () {
					yield* Ref.update(dependencyGraphRef, (graph) => {
						const deps = graph.get(name) ?? new Set<string>();
						deps.add(dependsOn);
						return new Map(graph).set(name, deps);
					});
					// Invalidate both caches
					cachedEventHandlerOrder = null;
					signalHandlerOrderCache.clear();
				}),

			validateNoCycles: () =>
				Effect.gen(function* () {
					const graph = yield* Ref.get(dependencyGraphRef);
					const visited = new Set<string>();
					const inStack = new Set<string>();
					const dfs = (node: string, path: string[]): string[] | null => {
						if (inStack.has(node)) return [...path, node];
						if (visited.has(node)) return null;
						visited.add(node);
						inStack.add(node);
						for (const dep of graph.get(node) ?? []) {
							const cycle = dfs(dep, [...path, node]);
							if (cycle) return cycle;
						}
						inStack.delete(node);
						return null;
					};
					for (const node of graph.keys()) {
						const cycle = dfs(node, []);
						if (cycle) {
							return yield* Effect.die(
								new ProjectionBusCycleError({
									nodes: [...graph.keys()],
									edges: graph as unknown as ReadonlyMap<string, ReadonlySet<string>>,
								}),
							);
						}
					}
				}),

			processEvent: (event: EventEnvelope) =>
				Effect.gen(function* () {
					yield* Ref.set(currentEventTimestampRef, Date.parse(event.timestamp));
					const handlers = yield* Ref.get(eventHandlersRef);
					const graph = yield* Ref.get(dependencyGraphRef);
					if (!cachedEventHandlerOrder) {
						const handlerNames = handlers.map((h) => h.name);
						cachedEventHandlerOrder = topologicalSort(handlerNames, graph);
					}
					const nameToHandler = new Map(handlers.map((h) => [h.name, h]));
					for (const name of cachedEventHandlerOrder) {
						const handlerItem = nameToHandler.get(name);
						if (handlerItem?.eventTypes.includes(event.type)) {
							yield* handlerItem.handler(event).pipe(
								Effect.catchAllCause((cause: unknown) =>
									reporter.report({
										_tag: "ProjectionEventHandlerError",
										projectionName: name,
										eventType: event.type,
										cause,
									} as never),
								),
							);
						}
					}
					yield* flushSignalQueue;
				}),

			processAmbientChange: (ambientName: string, value: unknown) =>
				Effect.gen(function* () {
					const graph = yield* Ref.get(dependencyGraphRef);
					const ambientHandlers = yield* Ref.get(ambientHandlersRef);
					const handlers = ambientHandlers.get(ambientName) ?? [];
					if (handlers.length === 0) return;
					const handlerNames = handlers.map((h) => h.name);
					const sortedNames = topologicalSort(handlerNames, graph);
					const nameToHandler = new Map(handlers.map((h) => [h.name, h]));
					for (const name of sortedNames) {
						const handlerItem = nameToHandler.get(name);
						if (handlerItem) {
							yield* handlerItem.handler(value).pipe(
								Effect.catchAllCause((cause: unknown) =>
									reporter.report({
										_tag: "ProjectionSignalHandlerError",
										projectionName: name,
										signalName: `ambient:${ambientName}`,
										cause,
									} as never),
								),
							);
						}
					}
					yield* flushSignalQueue;
				}),

			flushSignalQueue: () => flushSignalQueue,

			getProjectionState: (name: string) =>
				Effect.sync(() => {
					const entry = stateGetters.get(name);
					if (!entry) {
						throw new Error(`No state getter registered for projection "${name}"`);
					}
					return entry.getter();
				}),
		} satisfies ProjectionBusShape;
	}),
);
