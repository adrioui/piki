// G12. Surface abstraction
// Aggregates foundation-context Tags into one handle and binds command/signal records.
import { type Context, Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { type Ambient, AmbientLive } from "./ambient-service.ts";
import type { EventSinkTag } from "./event-sink-tag.ts";
import {
	FrameworkErrorPubSubLive,
	type FrameworkErrorReporter,
	FrameworkErrorReporterLive,
} from "./framework-error.ts";
import { type HydrationContext, HydrationContextLive } from "./hydration-context.ts";
import type { ProjectionStoreTag } from "./projection-store-tag.ts";
import type { RoleHostTag } from "./role-host-tag.ts";
import { type TraceBus, TraceBusLive } from "./trace-bus.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SurfaceCommand<A extends readonly unknown[] = readonly unknown[], R = unknown> {
	readonly _tag: "Command";
	readonly run: (...args: A) => Effect.Effect<R, never, SurfaceCtx>;
}

export interface SurfaceSignal<A extends readonly unknown[] = readonly unknown[]> {
	readonly _tag: "Signal";
	readonly kind: "stream" | "fn";
	readonly stream:
		| ((...args: A) => Stream.Stream<unknown, never, SurfaceCtx>)
		| Stream.Stream<unknown, never, SurfaceCtx>;
}

/** Union of all foundation Tags a surface can access. */
export type SurfaceCtx =
	| typeof Ambient
	| typeof TraceBus
	| typeof HydrationContext
	| typeof FrameworkErrorReporter
	| typeof EventSinkTag
	| typeof ProjectionStoreTag
	| typeof RoleHostTag;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function SurfaceCommand<A extends readonly unknown[], R>(
	run: (...args: A) => Effect.Effect<R, never, SurfaceCtx>,
): SurfaceCommand<A, R> {
	return { _tag: "Command", run };
}

export function SurfaceSignalStream(stream: Stream.Stream<unknown, never, SurfaceCtx>): SurfaceSignal<readonly []> {
	return { _tag: "Signal", kind: "stream", stream: stream as never };
}

export function SurfaceSignalFn<A extends readonly unknown[]>(
	fn: (...args: A) => Stream.Stream<unknown, never, SurfaceCtx>,
): SurfaceSignal<A> {
	return { _tag: "Signal", kind: "fn", stream: fn };
}

// ---------------------------------------------------------------------------
// Static layer (parameterless lives only)
// EventSinkTag, ProjectionStoreTag, RoleHostTag require concrete instances;
// callers compose them at use-site: Layer.mergeAll(SurfaceLayer, makeEventSinkLayer(sink), ...)
// ---------------------------------------------------------------------------

/** FrameworkErrorReporterLive requires FrameworkErrorPubSub, so provideMerge both. */
const frameworkErrorLayer = FrameworkErrorReporterLive.pipe(Layer.provideMerge(FrameworkErrorPubSubLive));

export const SurfaceLayer = Layer.mergeAll(AmbientLive, TraceBusLive, HydrationContextLive, frameworkErrorLayer);

// ---------------------------------------------------------------------------
// Recursive binder for the effect-surface binding helper.
// ---------------------------------------------------------------------------

/**
 * Bind a surface leaf (Command, Signal, or nested record) with a built
 * Effect Context. The `as never` casts are necessary for the generic record
 * walker — this is the "any unless absolutely necessary" case from AGENTS.md.
 */
function bindEffectSurface<T>(value: T, ctx: Context.Context<SurfaceCtx>): T {
	const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

	if (isRec(value) && value._tag === "Command") {
		const run = (value as unknown as { run: (...a: readonly unknown[]) => Effect.Effect<unknown> }).run;
		return ((...args: readonly unknown[]) =>
			(run(...args) as Effect.Effect<unknown>).pipe(Effect.provide(ctx as never))) as never;
	}

	if (isRec(value) && value._tag === "Signal") {
		const sig = value as unknown as {
			kind: "stream" | "fn";
			stream: ((...a: readonly unknown[]) => Stream.Stream<unknown>) | Stream.Stream<unknown>;
		};
		if (sig.kind === "fn") {
			return ((...args: readonly unknown[]) =>
				(sig.stream as (...a: readonly unknown[]) => Stream.Stream<unknown>)(...args).pipe(
					Stream.provideContext(ctx as never),
				)) as never;
		}
		return (sig.stream as Stream.Stream<unknown>).pipe(Stream.provideContext(ctx as never)) as never;
	}

	if (isRec(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, child] of Object.entries(value)) {
			out[k] = bindEffectSurface(child, ctx);
		}
		return out as never;
	}

	return value;
}

// ---------------------------------------------------------------------------
// effectClient equivalent
// ---------------------------------------------------------------------------

/**
 * Lift a surface host (record of Command/Signal leaves) into an
 * Effect-context-bound client. Binds commands/signals to the surface host context.
 * Captures whatever the surrounding Effect layer provides.
 */
export function makeSurfaceClient<T extends Record<string, unknown>>(surface: T): Effect.Effect<T, never, SurfaceCtx> {
	return Effect.gen(function* () {
		const ctx = yield* Effect.context<SurfaceCtx>();
		return bindEffectSurface(surface, ctx);
	});
}

// ---------------------------------------------------------------------------
// vanillaClient equivalent
// ---------------------------------------------------------------------------

/**
 * Lift a surface host into a vanilla JS callback client backed by a
 * ManagedRuntime. Allocates the runtime, binds leaves, tracks active stream
 * subscriptions, and returns a `dispose()` to shut everything down.
 * Vanilla client bound to the surface host (no Effect context).
 */
export function makeVanillaClient<T extends Record<string, unknown>>(
	layer: Layer.Layer<unknown>,
	surface: T,
): {
	client: T;
	runtime: ManagedRuntime.ManagedRuntime<unknown, unknown>;
	dispose: () => Promise<void>;
} {
	const runtime = ManagedRuntime.make(layer);
	const activeStreams = new Set<{
		fiber: Fiber.Fiber<unknown, unknown>;
		interrupt: () => void;
		unsubscribe: () => void;
	}>();
	let disposed = false;

	const ensureOpen = () => {
		if (disposed) throw new Error("Surface client is disposed");
	};

	const subscribe = (stream: Stream.Stream<unknown>, cb: (v: unknown) => void): (() => void) => {
		ensureOpen();
		let closed = false;
		const fiber = runtime.runFork(Stream.runForEach(stream, (_v) => Effect.sync(() => cb(_v))));
		const entry = {
			fiber,
			interrupt: () => {
				void runtime.runPromise(Fiber.interrupt(fiber as never)).catch(() => {});
			},
			unsubscribe: () => {
				if (closed) return;
				closed = true;
				activeStreams.delete(entry);
				entry.interrupt();
			},
		};
		activeStreams.add(entry);
		return entry.unsubscribe;
	};

	const bindVanilla = (value: unknown): unknown => {
		const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

		if (isRec(value) && value._tag === "Command") {
			const run = (value as unknown as { run: (...a: readonly unknown[]) => Effect.Effect<unknown> }).run;
			return (...args: readonly unknown[]) => {
				ensureOpen();
				return runtime.runPromise(run(...args) as never);
			};
		}

		if (isRec(value) && value._tag === "Signal") {
			const sig = value as unknown as { kind: "stream" | "fn"; stream: unknown };
			if (sig.kind === "fn") {
				return (...args: readonly unknown[]) => {
					const cb = args[args.length - 1] as (v: unknown) => void;
					if (typeof cb !== "function") {
						throw new Error("Surface signal method requires a callback");
					}
					return subscribe(
						(sig.stream as (...a: readonly unknown[]) => Stream.Stream<unknown>)(...args.slice(0, -1)),
						cb,
					);
				};
			}
			return (cb: (v: unknown) => void) => subscribe(sig.stream as Stream.Stream<unknown>, cb);
		}

		if (isRec(value)) {
			const out: Record<string, unknown> = {};
			for (const [k, child] of Object.entries(value)) {
				out[k] = bindVanilla(child);
			}
			return out;
		}

		return value;
	};

	const client = bindVanilla(surface) as T;

	return {
		client,
		runtime,
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
