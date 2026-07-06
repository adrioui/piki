import { Context, Layer } from "effect";
import type { DefaultEventSink } from "../sink.ts";

export interface EventSinkTagShape {
	readonly sink: DefaultEventSink;
}

export class EventSinkTag extends Context.Service<EventSinkTag, EventSinkTagShape>()("EventSinkTag") {}

export function makeEventSinkLayer(sink: DefaultEventSink): Layer.Layer<EventSinkTag, never, never> {
	return Layer.succeed(EventSinkTag, { sink });
}
