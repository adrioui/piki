import { Context, Effect, Layer, type Stream } from "effect";
import { EventBusCoreTag } from "./event-bus-core.ts";

export interface WorkerBusShape {
	readonly publish: (event: any) => Effect.Effect<void, any, any>;
	readonly subscribeToTypes: (types: readonly string[]) => Stream.Stream<any, any, any>;
	readonly stream: Stream.Stream<any, any, any>;
	readonly subscribe: () => Effect.Effect<Stream.Stream<any, any, any>, any, any>;
}

export const WorkerBusTag = Context.GenericTag<WorkerBusShape>("@piki/WorkerBus");

export function makeWorkerBusLayer() {
	return Layer.scoped(
		WorkerBusTag,
		Effect.gen(function* () {
			const core = yield* EventBusCoreTag;
			return {
				publish: (event) => core.publish(event),
				subscribeToTypes: (types) => core.subscribeToTypes(types),
				stream: core.stream,
				subscribe: () => core.subscribe(),
			};
		}),
	);
}
