/**
 * Top-level harness orchestration — `createHarness` factory.
 *
 */

import { createToolCallId } from "@piki/ai/prompt/ids";
import { Effect, Layer, Queue, Ref, Stream } from "effect";
import type { HarnessTool } from "../tool/tool.ts";
import type { ToolkitImpl } from "../tool/toolkit.ts";
import {
	type DispatcherHooks,
	dispatch,
	type EmittedEvent,
	type ModelStreamEvent,
	type ToolInputParser,
} from "./dispatcher.ts";
import { createTurnReducer } from "./reducers.ts";
import type { EngineState, TurnEvent, TurnState } from "./types.ts";

// ── Model stream contract ────────────────────────────────────────

export interface ModelStreamOptions {
	readonly generateToolCallId?: () => string;
	readonly [key: string]: unknown;
}

export interface ModelStreamResult {
	readonly events: Stream.Stream<ModelStreamEvent>;
	readonly parsers: ReadonlyMap<string, ToolInputParser>;
	readonly requestId: string;
}

export interface ModelInterface {
	readonly stream: (
		prompt: unknown,
		toolDefs: readonly unknown[],
		options?: ModelStreamOptions,
	) => Effect.Effect<ModelStreamResult>;
}

// ── Harness hooks (dispatcher hooks + event-level hook) ──────────

export interface HarnessHooks extends DispatcherHooks {
	readonly onEvent?: (event: TurnEvent) => Effect.Effect<void>;
}

// ── Harness config ───────────────────────────────────────────────

export interface HarnessConfig {
	readonly toolkit: ToolkitImpl;
	readonly model: ModelInterface;
	readonly hooks?: HarnessHooks;
	readonly layer?: Layer.Layer<never, never, never>;
	readonly initialState?: EngineState;
	readonly maxThoughtChars?: number;
}

// ── Turn result ──────────────────────────────────────────────────

export interface TurnResult {
	readonly events: Stream.Stream<TurnEvent>;
	readonly state: Ref.Ref<TurnState>;
}

// ── Replay turn ──────────────────────────────────────────────────

export interface ReplayTurnResult {
	readonly feed: (event: TurnEvent) => Effect.Effect<void>;
	readonly state: Ref.Ref<TurnState>;
}

// ── Sentinel ─────────────────────────────────────────────────────

const END = Symbol("END");

// ── Event bridge ─────────────────────────────────────────────────
//
// `EmittedEvent` (dispatcher output) and `TurnEvent` (reducer input) describe
// the same runtime values but are structurally incompatible: `EmittedEvent`
// carries a string `_tag` plus an index signature, while `TurnEvent` is a
// closed literal union. Every event the dispatcher emits is, by construction,
// a valid `TurnEvent`. The dispatcher module is intentionally not modified
// here (see harness parity plan), so we bridge the single call site with one
// explicit assertion rather than a fragile runtime tag-filter that could
// silently drop or synthesize events.

function toTurnEvent(event: EmittedEvent): TurnEvent {
	return event as unknown as TurnEvent;
}

// ── createHarness ────────────────────────────────────────────────

/**
 * Create a harness for running turns against a model.
 *
 * Returns `runTurn`, `createReplayTurn`, and `getToolDefinitions`.
 * Matches capture L77103-77193.
 */
export function createHarness(config: HarnessConfig) {
	const { toolkit, hooks, model } = config;

	// Build tool definitions from toolkit
	const toolDefs: unknown[] = [];
	for (const key of toolkit.keys) {
		const entry = (toolkit.entries as Record<string, HarnessTool>)[key]!;
		toolDefs.push(entry.definition);
	}

	const turnReducer = createTurnReducer(toolkit);

	const makeStateRef = (initialOverride?: EngineState): Effect.Effect<Ref.Ref<TurnState>> => {
		const initial = initialOverride ? { ...turnReducer.initial, engine: initialOverride } : turnReducer.initial;
		return Ref.make<TurnState>(initial);
	};

	const makeFeedEvent = (stateRef: Ref.Ref<TurnState>, eventQueue?: Queue.Queue<EmittedEvent | typeof END>) => {
		return (event: EmittedEvent): Effect.Effect<void> =>
			Effect.gen(function* () {
				const turnEvent = toTurnEvent(event);
				yield* Ref.update(stateRef, (s) => turnReducer.step(s, turnEvent));

				if (hooks?.onEvent) {
					const onEventEffect = hooks.onEvent(turnEvent);
					yield* config.layer ? Effect.provide(onEventEffect, config.layer) : onEventEffect;
				}

				if (eventQueue) {
					yield* Queue.offer(eventQueue, event);
				}
			});
	};

	const createReplayTurn = Effect.fn("harness.createReplayTurn")(function* () {
		const stateRef = yield* makeStateRef();
		const feed = makeFeedEvent(stateRef);
		return { feed, state: stateRef };
	});

	const runTurn = Effect.fn("harness.runTurn")(function* (prompt: unknown, options?: ModelStreamOptions) {
		const priorIds = [...(config.initialState?.toolCallMap.keys() ?? [])];

		const generateToolCallId = (() => {
			let ordinal = 0;
			return (): string => {
				if (ordinal < priorIds.length) return priorIds[ordinal++]!;
				return createToolCallId();
			};
		})();

		const streamOpts: ModelStreamOptions = { generateToolCallId, ...options };

		const { events: modelEvents, parsers, requestId } = yield* model.stream(prompt, toolDefs, streamOpts);

		const stateRef = yield* makeStateRef(config.initialState);

		const eventQueue = yield* Queue.unbounded<EmittedEvent | typeof END>();

		const emitEvent = makeFeedEvent(stateRef, eventQueue);

		const processing = dispatch({
			events: modelEvents,
			parsers,
			toolkit,
			hooks,
			initialEngineState: config.initialState,
			emit: emitEvent,
			maxThoughtChars: config.maxThoughtChars,
			requestId,
		}).pipe(Effect.provide(config.layer ?? Layer.empty));

		yield* Effect.fork(processing.pipe(Effect.ensuring(Queue.offer(eventQueue, END))));

		const eventStream = Stream.fromQueue(eventQueue).pipe(
			Stream.takeWhile((item): item is TurnEvent => item !== END),
		);

		return { events: eventStream, state: stateRef };
	});

	return {
		runTurn,
		createReplayTurn,
		getToolDefinitions: (): unknown[] => toolDefs,
	};
}
