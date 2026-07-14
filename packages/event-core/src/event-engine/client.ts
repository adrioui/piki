import { type Context, Effect, Fiber, Layer, ManagedRuntime, type Stream } from "effect";

export interface EngineService {
	readonly send: (event: any) => Effect.Effect<void, any, any>;
	readonly interrupt: () => Effect.Effect<void, any, any>;
	readonly events: Stream.Stream<any, any, any>;
	readonly errors: Stream.Stream<any, any, any>;
	readonly stateGet: (name: string) => Effect.Effect<any, any, any>;
	readonly stateGetFork: (name: string, forkId: string | null) => Effect.Effect<any, any, any>;
	readonly subscribeSignal: (
		name: string,
		callback: (value: any) => void,
	) => Effect.Effect<Fiber.Fiber<void, unknown>, any, any>;
	readonly subscribeState: (
		name: string,
		callback: (state: any) => void,
	) => Effect.Effect<Fiber.Fiber<void, unknown>, any, any>;
	readonly subscribeStateFork: (
		name: string,
		forkId: string | null,
		callback: (state: any) => void,
	) => Effect.Effect<Fiber.Fiber<void, unknown>, any, any>;
	readonly subscribeEvent: (callback: (event: any) => void) => Effect.Effect<Fiber.Fiber<void, unknown>, any, any>;
	readonly subscribeError: (callback: (error: any) => void) => Effect.Effect<Fiber.Fiber<void, unknown>, any, any>;
}

export interface CreateManagedClientOptions {
	readonly engineLayer: Layer.Layer<any, any, any>;
	readonly requirementsLayer?: Layer.Layer<any, any, any>;
	readonly expose: {
		readonly signals?: Record<string, { tag: Context.Tag<any, any> }>;
		readonly state?: Record<
			string,
			{ isForked: boolean; Tag: Context.Tag<any, any>; state: { changes: Stream.Stream<any, any, any> } }
		>;
	};
	readonly getEngine: (context: Context.Context<any>) => EngineService;
}

export interface ManagedClient {
	readonly on: Record<string, (callback: (value: any) => void) => () => void>;
	readonly state: Record<string, any>;
	readonly send: (event: any) => Promise<void>;
	readonly onEvent: (callback: (event: any) => void) => () => void;
	readonly onError: (callback: (error: any) => void) => () => void;
	readonly runEffect: (effect: Effect.Effect<any, any, any>) => Promise<any>;
	readonly interrupt: () => Promise<void>;
	readonly dispose: () => Promise<void>;
}

export async function createManagedClient(options: CreateManagedClientOptions): Promise<ManagedClient> {
	const ReqLayer = options.requirementsLayer ?? (Layer.empty as unknown as Layer.Layer<any, any, any>);
	const FinalLayer = Layer.provideMerge(options.engineLayer, ReqLayer) as unknown as Layer.Layer<any, any, never>;
	const runtime = ManagedRuntime.make(FinalLayer);
	const ctx = await runtime.runPromise(Effect.context<any>());
	const engine = options.getEngine(ctx);
	const fiberPromises = new Map<string, Promise<Fiber.Fiber<any, unknown>>>();
	let disposed = false;

	const subscribe = (setupEffect: Effect.Effect<Fiber.Fiber<any, unknown>, any, any>, key: string): (() => void) => {
		const promise = runtime.runPromise(setupEffect);
		fiberPromises.set(key, promise);
		promise.catch(() => fiberPromises.delete(key));
		return () => {
			const p = fiberPromises.get(key);
			if (!p) return;
			fiberPromises.delete(key);
			p.then((fiber) => {
				Effect.runPromise(Fiber.interrupt(fiber as never)).catch(() => {});
			}).catch(() => {});
		};
	};

	const onHandlers: Record<string, (callback: (value: any) => void) => () => void> = {};
	if (options.expose.signals) {
		for (const name of Object.keys(options.expose.signals)) {
			onHandlers[name] = (callback) => subscribe(engine.subscribeSignal(name, callback), `signal:${name}`);
		}
	}

	const stateHandlers: Record<string, any> = {};
	if (options.expose.state) {
		for (const [name, projection] of Object.entries(options.expose.state)) {
			if (projection.isForked) {
				stateHandlers[name] = {
					getFork: (forkId: string | null) => runtime.runPromise(engine.stateGetFork(name, forkId)),
					subscribeFork: (forkId: string | null, callback: (state: any) => void) =>
						subscribe(
							engine.subscribeStateFork(name, forkId, callback),
							`state:${name}:fork:${forkId ?? "null"}`,
						),
				};
			} else {
				stateHandlers[name] = {
					get: () => runtime.runPromise(engine.stateGet(name)),
					subscribe: (callback: (state: any) => void) =>
						subscribe(engine.subscribeState(name, callback), `state:${name}`),
				};
			}
		}
	}

	return {
		on: onHandlers,
		state: stateHandlers,
		send: (event) => runtime.runPromise(engine.send(event)),
		onEvent: (callback) => subscribe(engine.subscribeEvent(callback), "onEvent"),
		onError: (callback) => subscribe(engine.subscribeError(callback), "onError"),
		runEffect: (effect) => runtime.runPromise(effect),
		interrupt: () => runtime.runPromise(engine.interrupt()),
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			await runtime.dispose();
		},
	};
}
