import { Cause, Context, Effect, Layer, Stream } from "effect";
import { FrameworkError, FrameworkErrorReporter } from "../core/framework-error.ts";
import { HydrationContext } from "../core/hydration-context.ts";
import { InterruptCoordinator } from "../core/interrupt-coordinator.ts";
import { WorkerBusTag } from "../core/worker-bus.ts";
import type { ProjectionDefinition } from "../projection/define.ts";
import type { ForkedProjectionDefinition } from "../projection/defineForked.ts";
import type { Signal } from "../signal/define.ts";
import { extractForkIdFromEvent, extractForkIdFromSignal } from "./util.ts";

export type AnyProjection = ProjectionDefinition | ForkedProjectionDefinition;

export interface WorkerConfig {
	readonly name: string;
	readonly eventHandlers?: Record<
		string,
		(
			event: any,
			publish: (event: any) => Effect.Effect<void, unknown, unknown>,
			read: WorkerReadFn,
		) => Effect.Effect<void, unknown, unknown>
	>;
	readonly onProjectionsSettled?: (ctx: {
		publish: (event: any) => Effect.Effect<void, unknown, unknown>;
		read: WorkerReadFn;
	}) => Effect.Effect<void, unknown, unknown>;
	readonly signalHandlers?: (
		on: (
			signal: Signal,
			handler: (
				value: any,
				publish: (event: any) => Effect.Effect<void, unknown, unknown>,
				read: WorkerReadFn,
			) => Effect.Effect<void, unknown, unknown>,
		) => {
			signal: Signal;
			handler: (
				value: any,
				publish: (event: any) => Effect.Effect<void, unknown, unknown>,
				read: WorkerReadFn,
			) => Effect.Effect<void, unknown, unknown>;
		},
	) => Array<{
		signal: Signal;
		handler: (
			value: any,
			publish: (event: any) => Effect.Effect<void, unknown, unknown>,
			read: WorkerReadFn,
		) => Effect.Effect<void, unknown, unknown>;
	}>;
	readonly ignoreInterrupt?: readonly string[];
}

export type WorkerReadFn = ((
	projection: AnyProjection,
	overrideForkId?: string | null,
) => Effect.Effect<any, any, any>) & {
	allForks: (projection: AnyProjection) => Effect.Effect<Map<string | null, any>, any, any>;
};

export interface WorkerDefinition {
	readonly Tag: Context.Tag<any, any>;
	readonly Layer: Layer.Layer<any, any, any>;
}

function makeWorkerReadFn(forkId: string | null): WorkerReadFn {
	const impl = (projection: AnyProjection, overrideForkId?: string | null): Effect.Effect<any, any, any> => {
		const targetForkId = overrideForkId !== undefined ? overrideForkId : forkId;
		if (projection.isForked) {
			return Effect.flatMap(projection.Tag, (instance: any) => instance.getFork(targetForkId));
		}
		return Effect.flatMap(projection.Tag, (instance: any) => instance.get);
	};
	impl.allForks = (projection: AnyProjection) =>
		Effect.flatMap(projection.Tag, (instance: any) => instance.getAllForks());
	return impl as WorkerReadFn;
}

export function define(): (config: WorkerConfig) => WorkerDefinition {
	return (config: WorkerConfig): WorkerDefinition => {
		const serviceName = `${config.name}Worker`;
		const Tag = Context.GenericTag<any>(serviceName);

		const Live = Layer.scoped(
			Tag,
			Effect.gen(function* () {
				const bus = yield* WorkerBusTag;
				const hydration = yield* HydrationContext;
				const interruptCoordinator = yield* InterruptCoordinator;
				const reporter = yield* FrameworkErrorReporter;

				if (yield* hydration.isHydrating()) return;

				const publish = (event: any) => bus.publish(event);

				const withInterrupt = (
					handler: Effect.Effect<void, unknown, unknown>,
					targetForkId: string | null,
				): Effect.Effect<void, unknown, unknown> =>
					Effect.gen(function* () {
						const baseline = yield* interruptCoordinator.current(targetForkId);
						return yield* Effect.raceFirst(
							handler,
							interruptCoordinator.waitForInterrupt(targetForkId, baseline),
						);
					});

				if (config.eventHandlers) {
					const eventTypes = Object.keys(config.eventHandlers);
					const ignoreInterrupt = config.ignoreInterrupt ?? [];
					if (eventTypes.length > 0) {
						yield* Effect.forkScoped(
							Stream.runForEach(bus.subscribeToTypes(eventTypes), ((
								event: any,
							): Effect.Effect<void, unknown, unknown> => {
								const handler = config.eventHandlers![event.type];
								if (handler) {
									const forkId = extractForkIdFromEvent(event);
									const read = makeWorkerReadFn(forkId);
									const handlerEffect = handler(event, publish, read);
									const withErrorBoundary = (effect: Effect.Effect<void, unknown, unknown>) =>
										effect.pipe(
											Effect.catchAllCause((cause) => {
												if (Cause.isInterruptedOnly(cause)) return Effect.void;
												return reporter.report(
													FrameworkError.WorkerEventHandlerError({
														workerName: config.name,
														eventType: event.type,
														cause,
													}),
												);
											}),
										);
									if (ignoreInterrupt.includes(event.type)) {
										return withErrorBoundary(handlerEffect) as Effect.Effect<void, unknown, unknown>;
									}
									return withErrorBoundary(withInterrupt(handlerEffect, forkId)) as Effect.Effect<
										void,
										unknown,
										unknown
									>;
								}
								return Effect.void;
							}) as never),
						);
					}
				}

				if (config.onProjectionsSettled) {
					const settledRead = makeWorkerReadFn(null);
					const settledStream = yield* bus.subscribe();
					yield* Effect.forkScoped(
						Stream.runForEach(
							settledStream,
							((): Effect.Effect<void, unknown, unknown> =>
								Effect.gen(function* () {
									yield* config.onProjectionsSettled!({ publish, read: settledRead });
								}).pipe(
									Effect.catchAllCause((cause) => {
										if (Cause.isInterruptedOnly(cause)) return Effect.void;
										return reporter.report(
											FrameworkError.WorkerSettledHandlerError({
												workerName: config.name,
												cause,
											}),
										);
									}),
								)) as never,
						),
					);
				}

				if (config.signalHandlers) {
					const on = (signal: Signal, handler: any) => ({ signal, handler });
					const handlerPairs = config.signalHandlers(on as any);
					for (const { signal, handler } of handlerPairs) {
						const pubsub = yield* signal.tag;
						yield* Effect.forkScoped(
							Stream.runForEach(
								Stream.fromPubSub(pubsub),
								((value: any): Effect.Effect<void, unknown, unknown> =>
									Effect.gen(function* () {
										if (yield* hydration.isHydrating()) return;
										const signalForkId = extractForkIdFromSignal(value);
										const read = makeWorkerReadFn(signalForkId);
										yield* withInterrupt(handler(value, publish, read), signalForkId);
									}).pipe(
										Effect.catchAllCause((cause) => {
											if (Cause.isInterruptedOnly(cause)) return Effect.void;
											return reporter.report(
												FrameworkError.WorkerSignalHandlerError({
													workerName: config.name,
													signalName: signal.name,
													cause,
												}),
											);
										}),
									)) as never,
							),
						);
					}
				}
			}),
		);

		return { Tag, Layer: Live };
	};
}
