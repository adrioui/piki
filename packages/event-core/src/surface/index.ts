import type { Context } from "effect";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { Signal } from "../signal/define.ts";

export interface SurfaceCommand {
	readonly _tag: "Command";
	readonly run: (...args: readonly any[]) => Effect.Effect<any, any, any>;
}

export interface SurfaceSignal {
	readonly _tag: "Signal";
	readonly kind: "stream" | "fn";
	readonly stream: Stream.Stream<any, any, any> | ((...args: readonly any[]) => Stream.Stream<any, any, any>);
}

export function command(run: (...args: readonly any[]) => Effect.Effect<any, any, any>): SurfaceCommand {
	return { _tag: "Command", run };
}

export function signal(
	source: Signal | ((...args: readonly any[]) => Stream.Stream<any, any, any>) | Stream.Stream<any, any, any>,
): SurfaceSignal {
	if (source instanceof Signal) {
		return {
			_tag: "Signal",
			kind: "stream",
			stream: Stream.unwrap(Effect.map(source.tag, (pubsub) => Stream.fromPubSub(pubsub))),
		};
	}
	if (typeof source === "function") {
		return { _tag: "Signal", kind: "fn", stream: source };
	}
	return { _tag: "Signal", kind: "stream", stream: source };
}

export function state(projection: {
	isForked: boolean;
	Tag: Context.Tag<any, any>;
	state: { changes: Stream.Stream<any> };
}): Record<string, SurfaceCommand | SurfaceSignal> {
	if (projection.isForked) {
		return {
			getFork: command((forkId: string | null) =>
				Effect.flatMap(projection.Tag, (service: any) => service.getFork(forkId)),
			),
			subscribeFork: signal((forkId: string | null) =>
				Stream.unwrap(
					Effect.map(projection.Tag, (service: any) =>
						Stream.concat(
							Stream.fromEffect(service.getFork(forkId)),
							service.state.changes.pipe(
								Stream.mapEffect(() => service.getFork(forkId)),
								Stream.changes,
							),
						),
					),
				),
			),
		};
	}
	return {
		get: command(() => Effect.flatMap(projection.Tag, (service: any) => service.get)),
		subscribe: signal(
			Stream.unwrap(
				Effect.map(projection.Tag, (service: any) =>
					Stream.concat(Stream.fromEffect(service.get), service.state.changes),
				),
			),
		),
	};
}

export function host(config: { layer: Layer.Layer<any>; [key: string]: unknown }): {
	layer: Layer.Layer<any>;
	surface: Record<string, unknown>;
} {
	const { layer, ...surface } = config;
	return { layer, surface };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isCommand = (v: unknown): v is SurfaceCommand => isRecord(v) && v._tag === "Command";
const isSignal = (v: unknown): v is SurfaceSignal => isRecord(v) && v._tag === "Signal";

function provideEffect(effect: Effect.Effect<any, any, any>, ctx: Context.Context<any>): Effect.Effect<any, any, any> {
	return effect.pipe(Effect.provide(ctx as never) as never);
}

function provideStream(stream: Stream.Stream<any, any, any>, ctx: Context.Context<any>): Stream.Stream<any, any, any> {
	return stream.pipe(Stream.provideContext(ctx as never));
}

function bindEffectSurface(value: unknown, ctx: Context.Context<any>): unknown {
	if (isCommand(value)) {
		return (...args: readonly any[]) => provideEffect(value.run(...args), ctx);
	}
	if (isSignal(value)) {
		if (value.kind === "fn") {
			return (...args: readonly any[]) =>
				provideStream((value.stream as (...a: readonly any[]) => Stream.Stream<any>)(...args), ctx);
		}
		return provideStream(value.stream as Stream.Stream<any>, ctx);
	}
	if (isRecord(value)) {
		const bound: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			bound[key] = bindEffectSurface(child, ctx);
		}
		return bound;
	}
	return value;
}

export function effectClient(surfaceHost: {
	layer: Layer.Layer<any>;
	surface: Record<string, unknown>;
}): Effect.Effect<Record<string, unknown>, any, any> {
	return Effect.gen(function* () {
		const ctx = yield* Layer.build(surfaceHost.layer);
		return bindEffectSurface(surfaceHost.surface, ctx) as Record<string, unknown>;
	});
}

function bindVanillaSurface(
	value: unknown,
	runtime: ManagedRuntime.ManagedRuntime<any, any>,
	activeStreams: Set<{ fiber: Fiber.Fiber<any, any>; interrupt: () => void; unsubscribe: () => void }>,
	isDisposed: () => boolean,
): unknown {
	const ensureOpen = () => {
		if (isDisposed()) throw new Error("Surface client is disposed");
	};
	const subscribe = (stream: Stream.Stream<any>, callback: (v: any) => void): (() => void) => {
		ensureOpen();
		let closed = false;
		const fiber = runtime.runFork(Stream.runForEach(stream, (v) => Effect.sync(() => callback(v))));
		const interrupt = () => {
			void runtime.runPromise(Fiber.interrupt(fiber as never)).catch(() => {});
		};
		const entry = {
			fiber,
			interrupt,
			unsubscribe: () => {
				if (closed) return;
				closed = true;
				activeStreams.delete(entry);
				interrupt();
			},
		};
		activeStreams.add(entry);
		fiber.addObserver(() => activeStreams.delete(entry));
		return entry.unsubscribe;
	};

	if (isCommand(value)) {
		return (...args: readonly any[]) => {
			ensureOpen();
			return runtime.runPromise(value.run(...args));
		};
	}
	if (isSignal(value)) {
		if (value.kind === "fn") {
			return (...args: readonly any[]) => {
				const callback = args[args.length - 1] as (v: any) => void;
				if (typeof callback !== "function") throw new Error("Surface signal method requires a callback");
				return subscribe(
					(value.stream as (...a: readonly any[]) => Stream.Stream<any>)(...args.slice(0, -1)),
					callback,
				);
			};
		}
		return (callback: (v: any) => void) => subscribe(value.stream as Stream.Stream<any>, callback);
	}
	if (isRecord(value)) {
		const bound: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			bound[key] = bindVanillaSurface(child, runtime, activeStreams, isDisposed);
		}
		return bound;
	}
	return value;
}

export async function vanillaClient(surfaceHost: {
	layer: Layer.Layer<any>;
	surface: Record<string, unknown>;
}): Promise<Record<string, unknown> & { dispose: () => Promise<void> }> {
	const runtime = ManagedRuntime.make(surfaceHost.layer);
	await runtime.runPromise(Effect.context<never>());
	const activeStreams = new Set<{
		fiber: Fiber.Fiber<any, any>;
		interrupt: () => void;
		unsubscribe: () => void;
	}>();
	let disposed = false;
	const bound = bindVanillaSurface(surfaceHost.surface, runtime, activeStreams, () => disposed) as Record<
		string,
		unknown
	>;
	return {
		...bound,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			const streams = [...activeStreams];
			activeStreams.clear();
			await Promise.allSettled(streams.map((s) => s.interrupt()));
			await runtime.dispose();
		},
	};
}
