// packages/agent/src/workers/agent-lifecycle.ts
//
// AgentLifecycle owns the agent fork lifecycle. It is a plain `worker.define()`
// (non-forked) that:
//   - on `session_initialized`, initializes the root leader fork via
//     `ExecutionManager.initFork(null, "leader")`
//   - on `interrupt`, acknowledges and ignores the interrupt (it is listed in
//     `ignoreInterrupt`)
//   - on `agent_killed` / `subagent_user_killed` / `worker_idle_closed`,
//     disposes the associated fork via `ExecutionManager.disposeFork(forkId)`
//
// All real fork bookkeeping is delegated to the `ExecutionManager` service,
// implemented in `../execution/execution-manager.ts` (`ExecutionManagerLive`).
// This file defines the `ExecutionManager` `Context.GenericTag` plus the shape,
// and wires the real `ExecutionManagerLive` layer at assembly.

import { defineWorker, type WorkerDefinition } from "@piki/event-core";
import { Effect, Layer } from "effect";
import { ExecutionManager, ExecutionManagerLive } from "../execution/execution-manager.ts";

export { ExecutionManager, ExecutionManagerLive, type ExecutionManagerShape } from "../execution/execution-manager.ts";

// Backwards-compatible no-op kept only as a fallback for headless tests that need
// a layer without real fork bookkeeping. Production wiring uses `ExecutionManagerLive`.
export const ExecutionManagerNoop = Layer.succeed(ExecutionManager, {
	initFork: () => Effect.void,
	disposeFork: () => Effect.void,
	fork: () => Effect.die(new Error("ExecutionManagerNoop.fork is not supported")),
	getObservables: () => [],
	getForkLayer: () => undefined,
});

// ---------------------------------------------------------------------------
// Event payloads (typed boundary instead of `any`)
// ---------------------------------------------------------------------------

interface ForkClosedEvent {
	readonly forkId: string;
}

// ---------------------------------------------------------------------------
// Business logic (wrapped with Effect.fn for tracing)
// ---------------------------------------------------------------------------

const handleSessionInitialized = Effect.fn("AgentLifecycle.handleSessionInitialized")(function* () {
	const execManager = yield* ExecutionManager;
	yield* execManager.initFork(null, "leader");
});

const handleForkClosed = Effect.fn("AgentLifecycle.handleForkClosed")(function* (forkId: string) {
	const execManager = yield* ExecutionManager;
	yield* execManager.disposeFork(forkId);
});

// ---------------------------------------------------------------------------
// Worker definition (packages/agent/src/workers/agent-lifecycle.ts)
// ---------------------------------------------------------------------------

const AgentLifecycleDef: WorkerDefinition = defineWorker()({
	name: "AgentLifecycle",
	ignoreInterrupt: ["interrupt"],
	eventHandlers: {
		session_initialized: () => handleSessionInitialized().pipe(Effect.orDie),
		interrupt: () => Effect.void,
		agent_killed: (event: ForkClosedEvent) => handleForkClosed(event.forkId).pipe(Effect.orDie),
		subagent_user_killed: (event: ForkClosedEvent) => handleForkClosed(event.forkId).pipe(Effect.orDie),
		worker_idle_closed: (event: ForkClosedEvent) => handleForkClosed(event.forkId).pipe(Effect.orDie),
	},
});

export const AgentLifecycle = AgentLifecycleDef;

// Wire the real ExecutionManagerLive into the worker Layer, replacing the former
// Noop placeholder. Consumers that assemble the agent runtime use this Layer.
export const AgentLifecycleLive = Layer.provide(AgentLifecycleDef.Layer, ExecutionManagerLive);
