import { Context, Effect, PubSub, Stream } from "effect";

export class Signal {
	readonly name: string;
	readonly sourceProjectionName: string;
	readonly tag: Context.Tag<any, PubSub.PubSub<any>>;
	readonly _tag = "Signal";

	constructor(name: string, sourceProjectionName: string) {
		this.name = name;
		this.sourceProjectionName = sourceProjectionName;
		this.tag = Context.GenericTag<PubSub.PubSub<any>>(`Signal:${name}`);
	}
}

export function create(name: string): Signal {
	return new Signal(name, name);
}

export function createSignal(name: string, sourceProjectionName: string): Signal {
	return new Signal(name, sourceProjectionName);
}

export function fromDef(def: { name: string }, sourceProjectionName: string): Signal {
	return new Signal(def.name, sourceProjectionName);
}

export function stream(signal: Signal): Stream.Stream<any, never, any> {
	return Stream.unwrap(Effect.map(signal.tag, (pubsub) => Stream.fromPubSub(pubsub)));
}

export function emit(signal: Signal, value: unknown): Effect.Effect<void, never, any> {
	return Effect.flatMap(signal.tag, (pubsub) => PubSub.publish(pubsub, value));
}
