import { Context, Layer } from "effect";
import type { DefaultEventSink } from "../sink.ts";

export interface EventSinkTagShape {
	readonly sink: DefaultEventSink;
}

export const EventSinkTag = Context.GenericTag<EventSinkTagShape>("EventSinkTag");

export function makeEventSinkLayer(sink: DefaultEventSink) {
	return Layer.succeed(EventSinkTag, { sink });
}
