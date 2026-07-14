import { Context, Effect, type Fiber, Layer, Stream, SubscriptionRef } from "effect";
import { makeAmbientServiceLayer } from "../core/ambient-service.ts";
import { makeEventBusCoreLayer } from "../core/event-bus-core.ts";
import { makeEventSinkLayer } from "../core/event-sink.ts";
import {
	FrameworkError,
	FrameworkErrorPubSub,
	FrameworkErrorPubSubLive,
	FrameworkErrorReporter,
	FrameworkErrorReporterLive,
} from "../core/framework-error.ts";
import { HydrationContextLive } from "../core/hydration-context.ts";
import { InterruptCoordinatorLive } from "../core/interrupt-coordinator.ts";
import { makeProjectionBusLayer, ProjectionBus } from "../core/projection-bus.ts";
import { makeWorkerBusLayer, WorkerBusTag } from "../core/worker-bus.ts";
import type { ProjectionDefinition } from "../projection/define.ts";
import type { ForkedProjectionDefinition } from "../projection/defineForked.ts";
import type { WorkerDefinition } from "../worker/define.ts";
import type { ForkedWorkerDefinition } from "../worker/defineForked.ts";
import { createManagedClient, type EngineService, type ManagedClient } from "./client.ts";

export const Service = Context.GenericTag<EngineService>("@piki/EventEngine");

export interface MakeConfig {
	readonly projections: ReadonlyArray<ProjectionDefinition | ForkedProjectionDefinition>;
	readonly workers: ReadonlyArray<WorkerDefinition | ForkedWorkerDefinition>;
	readonly expose?: {
		readonly signals?: Record<string, { tag: Context.Tag<any, any>; name: string }>;
		readonly state?: Record<string, ProjectionDefinition | ForkedProjectionDefinition>;
	};
}

function make() {
	return (config: MakeConfig) => {
		const ProjectionBusLayer = makeProjectionBusLayer();
		const EventBusCoreLayer = makeEventBusCoreLayer();
		const WorkerBusLayer = makeWorkerBusLayer();
		const AmbientServiceLayer = makeAmbientServiceLayer();
		const FrameworkErrorReporterProvided = Layer.provide(FrameworkErrorReporterLive, FrameworkErrorPubSubLive);
		const CoreDeps = Layer.mergeAll(
			HydrationContextLive,
			makeEventSinkLayer(),
			InterruptCoordinatorLive,
			FrameworkErrorPubSubLive,
			FrameworkErrorReporterProvided,
		);
		const WithProjectionBus = Layer.provideMerge(ProjectionBusLayer, CoreDeps);
		const WithAmbientService = Layer.provideMerge(AmbientServiceLayer, WithProjectionBus);
		const WithEventBusCore = Layer.provideMerge(EventBusCoreLayer, WithAmbientService);
		const WithWorkerBus = Layer.provideMerge(WorkerBusLayer, WithEventBusCore);
		const BaseLayer = WithWorkerBus;

		const projectionLayers = config.projections.map((p) => p.Layer);
		const ProjectionsLayer =
			projectionLayers.length > 0 ? projectionLayers.reduce((acc, l) => Layer.provideMerge(l, acc)) : Layer.empty;
		const workerLayers = config.workers.map((w) => w.Layer);
		const WorkersLayer =
			workerLayers.length > 0 ? workerLayers.reduce((acc, l) => Layer.provideMerge(l, acc)) : Layer.empty;
		const AppLayer = Layer.provideMerge(WorkersLayer, Layer.provideMerge(ProjectionsLayer, BaseLayer));

		const expose = config.expose ?? {};

		const EventEngineLive = Layer.scoped(
			Service,
			Effect.gen(function* () {
				const engineScope = yield* Effect.scopedWith((scope) => Effect.succeed(scope));
				const bus = yield* WorkerBusTag;
				const projectionBus = yield* ProjectionBus;
				yield* projectionBus.validateNoCycles();
				const frameworkErrorPubSub = yield* FrameworkErrorPubSub;
				const frameworkErrorReporter = yield* FrameworkErrorReporter;

				const signalPubSubs = new Map<string, any>();
				if (expose.signals) {
					for (const [name, signal] of Object.entries(expose.signals)) {
						signalPubSubs.set(name, yield* signal.tag);
					}
				}

				const stateServices = new Map<string, any>();
				if (expose.state) {
					for (const [name, projection] of Object.entries(expose.state)) {
						stateServices.set(name, yield* projection.Tag);
					}
				}

				const guardAndFork = (
					name: string,
					effect: Effect.Effect<any, any, any>,
				): Effect.Effect<Fiber.Fiber<void, unknown>, any, any> =>
					Effect.forkIn(
						effect.pipe(
							Effect.catchAllCause((cause) =>
								frameworkErrorReporter.report(
									FrameworkError.SubscriptionError({ subscriptionName: name, cause }),
								),
							),
						),
						engineScope,
					);

				const engine: EngineService = {
					send: (event) => bus.publish(event),
					interrupt: () => bus.publish({ type: "interrupt" }),
					events: bus.stream,
					errors: Stream.fromPubSub(frameworkErrorPubSub.pubsub),
					stateGet: (name) =>
						Effect.gen(function* () {
							const projection = stateServices.get(name);
							if (!projection?.get) return;
							return yield* projection.get;
						}),
					stateGetFork: (name, forkId) =>
						Effect.gen(function* () {
							const projection = stateServices.get(name);
							if (!projection?.getFork) return;
							return yield* projection.getFork(forkId);
						}),
					subscribeSignal: (name, callback) =>
						Effect.gen(function* () {
							const pubsub = signalPubSubs.get(name);
							if (!pubsub) return yield* Effect.die(new Error(`Unknown signal: ${name}`));
							return yield* guardAndFork(
								`signal:${name}`,
								Stream.runForEach(Stream.fromPubSub(pubsub), (value: any) =>
									Effect.sync(() => callback(value)),
								),
							);
						}),
					subscribeState: (name, callback) =>
						Effect.gen(function* () {
							const p = stateServices.get(name);
							if (!p) return yield* Effect.die(new Error(`Unknown state: ${name}`));
							const initial = yield* SubscriptionRef.get(p.state);
							yield* Effect.sync(() => callback(initial));
							return yield* guardAndFork(
								`state:${name}`,
								Stream.runForEach(p.state.changes, (state: any) => Effect.sync(() => callback(state))),
							);
						}),
					subscribeStateFork: (name, forkId, callback) =>
						Effect.gen(function* () {
							const p = stateServices.get(name);
							if (!p?.getFork) return yield* Effect.die(new Error(`Unknown forked state: ${name}`));
							const getFork = p.getFork;
							const initial = yield* getFork(forkId);
							yield* Effect.sync(() => callback(initial));
							return yield* guardAndFork(
								`state:${name}:fork`,
								Stream.runForEach(
									p.state.changes.pipe(
										Stream.mapEffect(() => getFork(forkId)),
										Stream.changes,
									),
									(forkState: any) => Effect.sync(() => callback(forkState)),
								),
							);
						}),
					subscribeEvent: (callback) =>
						guardAndFork(
							"onEvent",
							Stream.runForEach(bus.stream, (event: any) => Effect.sync(() => callback(event))),
						),
					subscribeError: (callback) =>
						guardAndFork(
							"onError",
							Stream.runForEach(Stream.fromPubSub(frameworkErrorPubSub.pubsub), (error: any) =>
								Effect.sync(() => callback(error)),
							),
						),
				};

				return engine;
			}),
		);

		const EngineLayer = Layer.provideMerge(EventEngineLive, AppLayer);

		const createClient = async (requirementsLayer?: Layer.Layer<any, any, any>): Promise<ManagedClient> =>
			createManagedClient({
				engineLayer: EngineLayer,
				requirementsLayer,
				expose: expose as any,
				getEngine: (context) => Context.unsafeGet(context, Service),
			});

		return {
			Layer: AppLayer,
			EngineLayer,
			expose,
			projections: config.projections,
			createClient,
		};
	};
}

export { make };
