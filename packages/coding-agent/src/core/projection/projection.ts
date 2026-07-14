import { Context, Effect, Layer } from "effect";

export interface SignalDef {
	name: string;
}

export interface ProjectionConfig<T> {
	name: string;
	initial: T;
	signals?: Record<string, SignalDef>;
	reads?: Projection<unknown>[];
	ambients?: Ambient<unknown>[];
	eventHandlers: Record<
		string,
		(ctx: {
			event: unknown;
			state: T;
			emit: Record<string, (value: unknown) => void>;
			ambient: { get: <A>(def: Ambient<A>) => A };
		}) => T
	>;
	signalHandlers?: (
		on: (signal: SignalDef, handler: (value: unknown) => T) => { signal: SignalDef; handler: (value: unknown) => T },
	) => { signal: SignalDef; handler: (value: unknown) => T }[];
}

export interface ProjectionRuntimeContext {
	emit?: (signal: SignalDef, value: unknown) => void;
	ambient?: <A>(def: Ambient<A>) => A;
}

export interface Projection<T = unknown> {
	name: string;
	Tag: Context.Tag<T, T>;
	Layer: Layer.Layer<never>;
	isForked: boolean;
	signals: Record<string, SignalDef>;
	initial: T;
	reduce: (state: T, eventType: string, event: unknown, context?: ProjectionRuntimeContext) => T;
}

export interface ForkedProjectionConfig<T> {
	name: string;
	initialFork: T;
	signals?: Record<string, SignalDef>;
	reads?: Projection<unknown>[];
	ambients?: Ambient<unknown>[];
	eventHandlers: Record<
		string,
		(ctx: {
			event: unknown;
			fork: T;
			emit: Record<string, (value: unknown) => void>;
			ambient: { get: <A>(def: Ambient<A>) => A };
		}) => T
	>;
	forkLifecycle: { activateOn: string; completeOn?: string | string[] };
	signalHandlers?: (
		on: (signal: SignalDef, handler: (value: unknown) => T) => { signal: SignalDef; handler: (value: unknown) => T },
	) => { signal: SignalDef; handler: (value: unknown) => T }[];
	ignoreInterrupt?: string[];
}

export function define<T>(): (config: ProjectionConfig<T>) => Projection<T> {
	return (config) => {
		const serviceName = `${config.name}Projection`;
		const Tag = Context.GenericTag<T>(serviceName);
		return {
			name: config.name,
			Tag,
			Layer: Layer.empty,
			isForked: false,
			signals: config.signals ?? {},
			initial: config.initial,
			reduce: (state, eventType, event, context) => {
				const handler = config.eventHandlers[eventType];
				if (!handler) return state;
				return handler({
					event,
					state,
					emit: buildEmit(config.signals ?? {}, context?.emit),
					ambient: { get: context?.ambient ?? ambientValue },
				});
			},
		};
	};
}

export function defineForked<T>(): (config: ForkedProjectionConfig<T>) => Projection<T> {
	return (config) => {
		const serviceName = `${config.name}Projection`;
		const Tag = Context.GenericTag<T>(serviceName);
		return {
			name: config.name,
			Tag,
			Layer: Layer.empty,
			isForked: true,
			signals: config.signals ?? {},
			initial: config.initialFork,
			reduce: (state, eventType, event, context) => {
				const handler = config.eventHandlers[eventType];
				if (!handler) return state;
				return handler({
					event,
					fork: state,
					emit: buildEmit(config.signals ?? {}, context?.emit),
					ambient: { get: context?.ambient ?? ambientValue },
				});
			},
		};
	};
}

export interface Ambient<T = unknown> {
	name: string;
	initial: T | Effect.Effect<T>;
	isForked: false;
}

export function ambientDefine<T>(config: { name: string; initial: T | Effect.Effect<T> }): Ambient<T> {
	return { name: config.name, initial: config.initial, isForked: false };
}

export function isEffectInitial<T>(value: T | Effect.Effect<T>): value is Effect.Effect<T> {
	return Effect.isEffect(value);
}

export function resolveAmbient<T>(ambient: Ambient<T>): Effect.Effect<T> {
	return isEffectInitial(ambient.initial) ? ambient.initial : Effect.succeed(ambient.initial);
}

export function createProjectionState<T>(projection: Projection<T>): T {
	return cloneProjectionState(projection.initial);
}

export function applyProjectionEvent<T>(
	projection: Projection<T>,
	state: T,
	eventType: string,
	event: unknown,
	context?: ProjectionRuntimeContext,
): T {
	return projection.reduce(state, eventType, event, context);
}

function buildEmit(
	signals: Record<string, SignalDef>,
	emit: ((signal: SignalDef, value: unknown) => void) | undefined,
): Record<string, (value: unknown) => void> {
	return Object.fromEntries(
		Object.entries(signals).map(([key, signal]) => [
			key,
			(value: unknown) => {
				emit?.(signal, value);
			},
		]),
	);
}

function ambientValue<T>(ambient: Ambient<T>): T {
	if (isEffectInitial(ambient.initial)) {
		throw new Error(`Ambient ${ambient.name} requires Effect resolution`);
	}
	return ambient.initial;
}

function cloneProjectionState<T>(state: T): T {
	if (state instanceof Map) {
		return new Map([...state.entries()].map(([key, value]) => [key, cloneProjectionState(value)])) as T;
	}
	if (state instanceof Set) {
		return new Set([...state.values()].map((value) => cloneProjectionState(value))) as T;
	}
	if (Array.isArray(state)) return state.map((value) => cloneProjectionState(value)) as T;
	if (state && typeof state === "object") {
		return Object.fromEntries(Object.entries(state).map(([key, value]) => [key, cloneProjectionState(value)])) as T;
	}
	return state;
}
