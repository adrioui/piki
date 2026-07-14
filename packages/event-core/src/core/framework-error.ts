import { Context, Data, Effect, Layer, PubSub, Stream } from "effect";

// Tagged error variants (matching Data.taggedEnum shape)

export class ProjectionEventHandlerError extends Data.TaggedError("ProjectionEventHandlerError")<{
	readonly projectionName: string;
	readonly eventType: string;
	readonly cause: unknown;
}> {}

export class ProjectionSignalHandlerError extends Data.TaggedError("ProjectionSignalHandlerError")<{
	readonly projectionName: string;
	readonly signalName: string;
	readonly cause: unknown;
}> {}

export class WorkerEventHandlerError extends Data.TaggedError("WorkerEventHandlerError")<{
	readonly workerName: string;
	readonly eventType: string;
	readonly cause: unknown;
}> {}

export class WorkerSignalHandlerError extends Data.TaggedError("WorkerSignalHandlerError")<{
	readonly workerName: string;
	readonly signalName: string;
	readonly cause: unknown;
}> {}

export class WorkerSettledHandlerError extends Data.TaggedError("WorkerSettledHandlerError")<{
	readonly workerName: string;
	readonly cause: unknown;
}> {}

export class WorkerLifecycleError extends Data.TaggedError("WorkerLifecycleError")<{
	readonly workerName: string;
	readonly eventType: string;
	readonly cause: unknown;
}> {}

export class SinkError extends Data.TaggedError("SinkError")<{
	readonly eventType: string;
	readonly cause: unknown;
}> {}

export class BroadcastError extends Data.TaggedError("BroadcastError")<{
	readonly eventType: string;
	readonly cause: unknown;
}> {}

export class SubscriptionError extends Data.TaggedError("SubscriptionError")<{
	readonly subscriptionName: string;
	readonly cause: unknown;
}> {}

export type FrameworkError =
	| ProjectionEventHandlerError
	| ProjectionSignalHandlerError
	| WorkerEventHandlerError
	| WorkerSignalHandlerError
	| WorkerSettledHandlerError
	| WorkerLifecycleError
	| SinkError
	| BroadcastError
	| SubscriptionError;

// Helper to create variant instances by name
export const FrameworkError = {
	ProjectionEventHandlerError: (args: { projectionName: string; eventType: string; cause: unknown }) =>
		new ProjectionEventHandlerError(args),
	ProjectionSignalHandlerError: (args: { projectionName: string; signalName: string; cause: unknown }) =>
		new ProjectionSignalHandlerError(args),
	WorkerEventHandlerError: (args: { workerName: string; eventType: string; cause: unknown }) =>
		new WorkerEventHandlerError(args),
	WorkerSignalHandlerError: (args: { workerName: string; signalName: string; cause: unknown }) =>
		new WorkerSignalHandlerError(args),
	WorkerSettledHandlerError: (args: { workerName: string; cause: unknown }) => new WorkerSettledHandlerError(args),
	WorkerLifecycleError: (args: { workerName: string; eventType: string; cause: unknown }) =>
		new WorkerLifecycleError(args),
	SinkError: (args: { eventType: string; cause: unknown }) => new SinkError(args),
	BroadcastError: (args: { eventType: string; cause: unknown }) => new BroadcastError(args),
	SubscriptionError: (args: { subscriptionName: string; cause: unknown }) => new SubscriptionError(args),
};

// --- PubSub Tag ---

export interface FrameworkErrorPubSubShape {
	readonly pubsub: PubSub.PubSub<FrameworkError>;
	readonly stream: Stream.Stream<FrameworkError>;
	readonly subscribe: () => Effect.Effect<Stream.Stream<FrameworkError>>;
}

export const FrameworkErrorPubSub = Context.GenericTag<FrameworkErrorPubSubShape>("@piki/FrameworkErrorPubSub");

export const FrameworkErrorPubSubLive = Layer.scoped(
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
	readonly report: (error: FrameworkError) => Effect.Effect<void>;
}

export const FrameworkErrorReporter = Context.GenericTag<FrameworkErrorReporterShape>("@piki/FrameworkErrorReporter");

export const FrameworkErrorReporterLive = Layer.scoped(
	FrameworkErrorReporter,
	Effect.gen(function* () {
		const pubsub = yield* FrameworkErrorPubSub;
		return {
			report: (error) =>
				PubSub.publish(pubsub.pubsub, error).pipe(
					Effect.catchAllCause(() => Effect.void),
					Effect.asVoid,
				),
		};
	}),
);
