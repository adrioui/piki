// packages/event-core/src/runtime/framework-error.ts
import { Context, Data, Effect, Layer, PubSub, Stream } from "effect";

// --- Tagged error variants ---

export class RoleError extends Data.TaggedError("RoleError")<{
	readonly roleId: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class ProjectionError extends Data.TaggedError("ProjectionError")<{
	readonly projectionName: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class ProviderError extends Data.TaggedError("ProviderError")<{
	readonly provider: string;
	readonly message: string;
	readonly status?: number;
}> {}

export class PermissionError extends Data.TaggedError("PermissionError")<{
	readonly requestId: string;
	readonly toolName: string;
	readonly message: string;
}> {}

export class WorkerSpawnError extends Data.TaggedError("WorkerSpawnError")<{
	readonly role: string;
	readonly forkId: string;
	readonly agentId: string;
	readonly reason: string;
}> {}

export class StorageError extends Data.TaggedError("StorageError")<{
	readonly operation: string;
	readonly path: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** Union of all framework error variants for catchTags / catchByTag. */
export type FrameworkError =
	| RoleError
	| ProjectionError
	| ProviderError
	| PermissionError
	| WorkerSpawnError
	| StorageError;

// --- PubSub Tag ---

export interface FrameworkErrorPubSubShape {
	readonly pubsub: PubSub.PubSub<FrameworkError>;
	readonly stream: Stream.Stream<FrameworkError>;
	readonly subscribe: () => Effect.Effect<Stream.Stream<FrameworkError>>;
}

export const FrameworkErrorPubSub = Context.GenericTag<FrameworkErrorPubSubShape>("@piki/FrameworkErrorPubSub");

/**
 * Live PubSub layer. `PubSub.unbounded` in effect@4.0.0-beta.93 returns
 * `Effect<PubSub, never, never>` (no Scope requirement), so `Layer.effect`
 * is the correct constructor — `Layer.scoped` does not exist in this beta.
 */
export const FrameworkErrorPubSubLive = Layer.effect(
	FrameworkErrorPubSub,
	Effect.gen(function* () {
		const pubsub = yield* PubSub.unbounded<FrameworkError>();
		return {
			pubsub,
			stream: Stream.fromPubSub(pubsub),
			subscribe: () => Effect.succeed(Stream.fromPubSub(pubsub)),
		};
	}),
);

// --- Reporter Tag ---

export interface FrameworkErrorReporterShape {
	/** Report an error to the bus. Never throws — publish failures are swallowed. */
	readonly report: (error: FrameworkError) => Effect.Effect<void>;
}

export const FrameworkErrorReporter = Context.GenericTag<FrameworkErrorReporterShape>("@piki/FrameworkErrorReporter");

export const FrameworkErrorReporterLive = Layer.effect(
	FrameworkErrorReporter,
	Effect.gen(function* () {
		const bus = yield* FrameworkErrorPubSub;
		return {
			report: (error: FrameworkError) =>
				PubSub.publish(bus.pubsub, error).pipe(
					Effect.catchAllCause(() => Effect.void),
					Effect.asVoid,
				),
		};
	}),
);
