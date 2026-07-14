import { Context, Effect, Layer, PubSub, SubscriptionRef } from "effect";
import { type AmbientDef, AmbientServiceTag } from "../core/ambient-service.ts";
import { ProjectionBus } from "../core/projection-bus.ts";
import { fromDef, type Signal } from "../signal/define.ts";

export interface ProjectionConfig<TState = any> {
	readonly name: string;
	readonly initial: TState;
	readonly reads?: ReadonlyArray<ProjectionRef>;
	readonly ambients?: ReadonlyArray<AmbientDef>;
	readonly signals?: Record<string, { name: string }>;
	readonly signalHandlers?: (
		on: (
			signal: Signal,
			handler: (ctx: SignalHandlerContext) => any,
		) => { signal: Signal; handler: (ctx: SignalHandlerContext) => any },
	) => Array<{ signal: Signal; handler: (ctx: SignalHandlerContext) => any }>;
	readonly ambientHandlers?: (
		on: (
			ambient: AmbientDef,
			handler: (ctx: AmbientHandlerContext) => any,
		) => { ambient: AmbientDef; handler: (ctx: AmbientHandlerContext) => any },
	) => Array<{ ambient: AmbientDef; handler: (ctx: AmbientHandlerContext) => any }>;
	readonly eventHandlers?: Record<string, (ctx: EventHandlerContext) => TState>;
}

export interface ProjectionRef {
	readonly name: string;
	readonly isForked?: boolean;
}

export interface SignalHandlerContext {
	readonly value: any;
	readonly source: unknown;
	readonly state: any;
	readonly emit: Record<string, (value: any) => void>;
	readonly read: (projection: ProjectionRef) => unknown;
	readonly ambient: { get: (def: AmbientDef) => unknown };
}

export interface AmbientHandlerContext {
	readonly value: unknown;
	readonly state: any;
	readonly emit: Record<string, (value: any) => void>;
	readonly read: (projection: ProjectionRef) => unknown;
	readonly ambient: { get: (def: AmbientDef) => unknown };
}

export interface EventHandlerContext {
	readonly event: any;
	readonly state: any;
	readonly emit: Record<string, (value: any) => void>;
	readonly read: (projection: ProjectionRef) => unknown;
	readonly ambient: { get: (def: AmbientDef) => unknown };
}

export interface ProjectionInstance<TState = any> {
	readonly state: SubscriptionRef.SubscriptionRef<TState>;
	readonly get: Effect.Effect<TState>;
}

export interface ProjectionDefinition<_TState = any> {
	readonly name: string;
	readonly isForked: boolean;
	readonly reads: readonly string[];
	readonly ambients: readonly AmbientDef[];
	readonly signalSubscriptions: ReadonlyArray<{ signal: string; source: string }>;
	readonly Tag: Context.Tag<any, any>;
	readonly Layer: Layer.Layer<any, any, any>;
	readonly signals: Record<string, Signal>;
}

export function define(): <TState>(config: ProjectionConfig<TState>) => ProjectionDefinition<TState> {
	return <TState>(config: ProjectionConfig<TState>): ProjectionDefinition<TState> => {
		const serviceName = `${config.name}Projection`;
		const Tag = Context.GenericTag<ProjectionInstance<TState>>(serviceName);
		const signalDefs = config.signals ?? {};
		const signals: Record<string, Signal> = {};
		for (const [key, def] of Object.entries(signalDefs)) {
			signals[key] = fromDef(def, config.name);
		}
		const typedSignals = signals;
		const signalEntries = Object.entries(signals);

		let SignalPubSubLayers: Layer.Layer<any, any, any> = Layer.empty as unknown as Layer.Layer<any, any, any>;
		for (const [, signal] of signalEntries) {
			const signalLayer = Layer.scoped(signal.tag, PubSub.unbounded<any>());
			SignalPubSubLayers = Layer.provideMerge(SignalPubSubLayers, signalLayer);
		}

		const readDeps = config.reads ?? [];
		const ambients = config.ambients ?? [];
		const allowedReadNames = new Set(readDeps.map((p) => p.name));
		const signalSubscriptions: Array<{ signal: string; source: string }> = [];

		if (config.signalHandlers) {
			const extractSignalName = (signal: Signal) => {
				signalSubscriptions.push({ signal: signal.name, source: signal.name.split("/")[0] });
				return { signal, handler: () => config.initial };
			};
			config.signalHandlers(extractSignalName as any);
		}

		const LogicLayer = Layer.scoped(
			Tag,
			Effect.gen(function* () {
				const bus = yield* ProjectionBus;
				const ambientService = yield* AmbientServiceTag;
				const stateRef = yield* SubscriptionRef.make(config.initial);

				for (const ambientDef of ambients) {
					yield* ambientService.register(ambientDef);
				}
				for (const dep of readDeps) {
					yield* bus.registerDependency(config.name, dep.name);
				}
				yield* bus.registerStateGetter(config.name, () => Effect.runSync(SubscriptionRef.get(stateRef)), false);

				const readFn = (projection: ProjectionRef): unknown => {
					if (!allowedReadNames.has(projection.name)) {
						throw new Error(
							`Projection "${config.name}" cannot read "${projection.name}" - not declared in reads`,
						);
					}
					return bus.getProjectionState(projection.name);
				};

				const ambientReader = { get: (def: AmbientDef) => ambientService.getValue(def) };

				const pubsubs: Record<string, PubSub.PubSub<any>> = {};
				for (const [, signal] of signalEntries) {
					pubsubs[signal.name] = yield* signal.tag;
				}

				let pendingSignalEffects: Effect.Effect<void>[] = [];
				const emitters: Record<string, (value: any) => void> = {};
				for (const [key, signal] of signalEntries) {
					const pubsub = pubsubs[signal.name];
					emitters[key] = (value: any) => {
						pendingSignalEffects.push(
							Effect.gen(function* () {
								const sourceState = yield* SubscriptionRef.get(stateRef);
								yield* bus.queueSignal(signal.name, value, sourceState);
								yield* PubSub.publish(pubsub, value);
							}),
						);
					};
				}
				const typedEmitters = emitters;

				const flushPendingSignals = Effect.gen(function* () {
					const effects = pendingSignalEffects;
					pendingSignalEffects = [];
					for (const effect of effects) yield* effect;
				});

				if (config.signalHandlers) {
					const on = (signal: Signal, handler: (ctx: SignalHandlerContext) => any) => ({ signal, handler });
					const handlerPairs = config.signalHandlers(on as any);
					for (const { signal, handler } of handlerPairs) {
						yield* bus.registerSignalHandler(
							signal.name,
							(value: any, sourceState: unknown) =>
								Effect.gen(function* () {
									yield* SubscriptionRef.update(stateRef, (currentState: any) =>
										handler({
											value,
											source: sourceState,
											state: currentState,
											emit: typedEmitters,
											read: readFn,
											ambient: ambientReader,
										}),
									);
									yield* flushPendingSignals;
								}),
							serviceName,
						);
					}
				}

				if (config.ambientHandlers) {
					const on = (ambient: AmbientDef, handler: (ctx: AmbientHandlerContext) => any) => ({ ambient, handler });
					const handlerPairs = config.ambientHandlers(on);
					for (const { ambient, handler } of handlerPairs) {
						yield* bus.registerAmbientHandler(
							ambient.name,
							(value: unknown) =>
								Effect.gen(function* () {
									yield* SubscriptionRef.update(stateRef, (currentState: any) =>
										handler({
											value,
											state: currentState,
											emit: typedEmitters,
											read: readFn,
											ambient: ambientReader,
										}),
									);
									yield* flushPendingSignals;
								}),
							serviceName,
						);
					}
				}

				const eventHandler = (event: any): Effect.Effect<void> => {
					if (!config.eventHandlers) return Effect.void;
					const handler = config.eventHandlers[event.type];
					if (!handler) return Effect.void;
					return Effect.gen(function* () {
						yield* SubscriptionRef.update(stateRef, (currentState: any) =>
							handler({ event, state: currentState, emit: typedEmitters, read: readFn, ambient: ambientReader }),
						);
						yield* flushPendingSignals;
					});
				};

				const eventTypes = config.eventHandlers ? Object.keys(config.eventHandlers) : [];
				yield* bus.register(eventHandler, eventTypes, serviceName);

				return { state: stateRef, get: SubscriptionRef.get(stateRef) };
			}),
		);

		const FullLayer = Layer.provideMerge(LogicLayer, SignalPubSubLayers);

		return {
			name: config.name,
			isForked: false,
			reads: readDeps.map((p) => p.name),
			ambients,
			signalSubscriptions,
			Tag,
			Layer: FullLayer,
			signals: typedSignals,
		};
	};
}
