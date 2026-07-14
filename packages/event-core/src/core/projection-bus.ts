import { Context, Effect, Layer, Ref } from "effect";
import { FrameworkError, FrameworkErrorReporter } from "./framework-error.ts";

const MAX_SIGNAL_FLUSH_ITERATIONS = 100;

export interface ProjectionBusShape {
	readonly register: (
		handler: (event: any) => Effect.Effect<void>,
		eventTypes: readonly string[],
		name: string,
	) => Effect.Effect<void>;
	readonly registerSignalHandler: (
		signalName: string,
		handler: (value: any, sourceState: unknown) => Effect.Effect<void>,
		projectionName: string,
	) => Effect.Effect<void>;
	readonly registerAmbientHandler: (
		ambientName: string,
		handler: (value: unknown) => Effect.Effect<void>,
		projectionName: string,
	) => Effect.Effect<void>;
	readonly queueSignal: (signalName: string, value: unknown, sourceState: unknown) => Effect.Effect<void>;
	readonly registerDependency: (from: string, to: string) => Effect.Effect<void>;
	readonly registerStateGetter: (name: string, getter: () => unknown, isForked: boolean) => Effect.Effect<void>;
	readonly getProjectionState: (name: string) => unknown;
	readonly getForkState: (name: string, forkId: string | null) => unknown;
	readonly validateNoCycles: () => Effect.Effect<void>;
	readonly processEvent: (event: any) => Effect.Effect<void>;
	readonly processAmbientChange: (ambientName: string, value: unknown) => Effect.Effect<void>;
}

export const ProjectionBus = Context.GenericTag<ProjectionBusShape>("@piki/ProjectionBus");

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
	if (sorted.length !== names.size) return [...handlerNames];
	return sorted;
}

export function makeProjectionBusLayer() {
	return Layer.scoped(
		ProjectionBus,
		Effect.gen(function* () {
			const reporter = yield* FrameworkErrorReporter;
			const eventHandlersRef = yield* Ref.make<
				Array<{ name: string; eventTypes: readonly string[]; handler: (event: any) => Effect.Effect<void> }>
			>([]);
			const signalHandlersRef = yield* Ref.make<
				Map<string, Array<{ name: string; handler: (value: any, sourceState: unknown) => Effect.Effect<void> }>>
			>(new Map());
			const ambientHandlersRef = yield* Ref.make<
				Map<string, Array<{ name: string; handler: (value: unknown) => Effect.Effect<void> }>>
			>(new Map());
			const signalQueueRef = yield* Ref.make<
				Array<{ signalName: string; value: unknown; sourceState: unknown; eventTimestamp: number }>
			>([]);
			const dependencyGraphRef = yield* Ref.make<Map<string, Set<string>>>(new Map());
			const stateGetters = new Map<string, { getter: () => unknown; isForked: boolean }>();
			let cachedEventHandlerOrder: string[] | null = null;
			const signalHandlerOrderCache = new Map<string, string[]>();

			const getDependencyGraph = (): Map<string, Set<string>> => Effect.runSync(Ref.get(dependencyGraphRef));

			const flushSignalQueue = Effect.gen(function* () {
				let iterations = 0;
				const graph = getDependencyGraph();
				while (true) {
					const queue = yield* Ref.getAndSet(signalQueueRef, []);
					if (queue.length === 0) break;
					if (iterations++ >= MAX_SIGNAL_FLUSH_ITERATIONS) {
						yield* Effect.logWarning(
							`Signal flush exceeded ${MAX_SIGNAL_FLUSH_ITERATIONS} iterations, possible infinite loop`,
						);
						break;
					}
					const signalHandlers = yield* Ref.get(signalHandlersRef);
					for (const { signalName, value, sourceState, eventTimestamp } of queue) {
						const timestampedValue = { ...(value as object), timestamp: eventTimestamp };
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
									Effect.catchAllCause((cause) =>
										reporter.report(
											FrameworkError.ProjectionSignalHandlerError({
												projectionName: name,
												signalName,
												cause,
											}),
										),
									),
								);
							}
						}
					}
				}
			});

			let currentEventTimestamp = Date.now();

			return {
				register: (handler, eventTypes, name) =>
					Effect.gen(function* () {
						yield* Ref.update(eventHandlersRef, (handlers) => [...handlers, { name, eventTypes, handler }]);
						cachedEventHandlerOrder = null;
					}),
				registerSignalHandler: (signalName, handler, projectionName) =>
					Effect.gen(function* () {
						const sourceProjection = signalName.split("/")[0] ?? projectionName;
						yield* Ref.update(dependencyGraphRef, (graph) => {
							const deps = graph.get(projectionName) ?? new Set<string>();
							if (sourceProjection !== projectionName) deps.add(sourceProjection);
							return new Map(graph).set(projectionName, deps);
						});
						yield* Ref.update(signalHandlersRef, (map) => {
							const existing = map.get(signalName) ?? [];
							return new Map(map).set(signalName, [...existing, { name: projectionName, handler }]);
						});
						signalHandlerOrderCache.delete(signalName);
					}),
				registerAmbientHandler: (ambientName, handler, projectionName) =>
					Effect.gen(function* () {
						yield* Ref.update(ambientHandlersRef, (map) => {
							const existing = map.get(ambientName) ?? [];
							return new Map(map).set(ambientName, [...existing, { name: projectionName, handler }]);
						});
					}),
				queueSignal: (signalName, value, sourceState) =>
					Ref.update(signalQueueRef, (queue) => [
						...queue,
						{ signalName, value, sourceState, eventTimestamp: currentEventTimestamp },
					]),
				registerDependency: (from, to) =>
					Effect.gen(function* () {
						yield* Ref.update(dependencyGraphRef, (graph) => {
							const deps = graph.get(from) ?? new Set<string>();
							deps.add(to);
							return new Map(graph).set(from, deps);
						});
						cachedEventHandlerOrder = null;
						signalHandlerOrderCache.clear();
					}),
				registerStateGetter: (name, getter, isForked) =>
					Effect.sync(() => {
						stateGetters.set(name, { getter, isForked });
					}),
				getProjectionState: (name) => {
					const entry = stateGetters.get(name);
					if (!entry) throw new Error(`No state getter registered for projection "${name}"`);
					return entry.getter();
				},
				getForkState: (name, forkId) => {
					const entry = stateGetters.get(name);
					if (!entry) throw new Error(`No state getter registered for projection "${name}"`);
					if (!entry.isForked) return entry.getter();
					const state = entry.getter() as { forks: Map<string | null, unknown> };
					return state.forks.get(forkId);
				},
				validateNoCycles: () =>
					Effect.gen(function* () {
						const graph = yield* Ref.get(dependencyGraphRef);
						const visited = new Set<string>();
						const inStack = new Set<string>();
						function dfs(node: string, path: string[]): string[] | null {
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
						}
						for (const node of graph.keys()) {
							const cycle = dfs(node, []);
							if (cycle) throw new Error(`Circular dependency detected: ${cycle.join(" → ")}`);
						}
					}),
				processEvent: (event) =>
					Effect.gen(function* () {
						currentEventTimestamp = (event as { timestamp: number }).timestamp ?? Date.now();
						const handlers = yield* Ref.get(eventHandlersRef);
						const graph = getDependencyGraph();
						if (!cachedEventHandlerOrder) {
							const handlerNames = handlers.map((h) => h.name);
							cachedEventHandlerOrder = topologicalSort(handlerNames, graph);
						}
						const nameToHandler = new Map(handlers.map((h) => [h.name, h]));
						for (const name of cachedEventHandlerOrder) {
							const handlerItem = nameToHandler.get(name);
							if (handlerItem?.eventTypes.includes(event.type)) {
								yield* handlerItem.handler(event).pipe(
									Effect.catchAllCause((cause) =>
										reporter.report(
											FrameworkError.ProjectionEventHandlerError({
												projectionName: name,
												eventType: event.type,
												cause,
											}),
										),
									),
								);
							}
						}
						yield* flushSignalQueue;
					}),
				processAmbientChange: (ambientName, value) =>
					Effect.gen(function* () {
						const graph = getDependencyGraph();
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
									Effect.catchAllCause((cause) =>
										reporter.report(
											FrameworkError.ProjectionSignalHandlerError({
												projectionName: name,
												signalName: `ambient:${ambientName}`,
												cause,
											}),
										),
									),
								);
							}
						}
						yield* flushSignalQueue;
					}),
			} satisfies ProjectionBusShape;
		}),
	);
}
