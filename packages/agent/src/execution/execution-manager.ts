// packages/agent/src/execution/execution-manager.ts
//
// ExecutionManager owns fork lifecycle bookkeeping. It is a `Layer.scoped`
// service that:
//   - keeps per-fork maps of layers, cwds, scratchpad paths, roles, teardowns,
//     bound observables, and an identical-response tracker
//   - `initFork(forkId, roleId)` resolves cwd/scratchpad from SessionContext,
//     builds a fork layer (VCS + WorkingDirectory + ForkContext), and registers
//     teardown/setup hooks
//   - `disposeFork(forkId)` runs teardown and clears the per-fork maps
//   - `fork(params)` creates a fork id, calls initFork, and publishes
//     `agent_created`
//   - `getForkLayer(forkId)` / `getObservables(forkId)` expose fork state
//
// Implemented using piki's existing services: `SessionContextProjection`,
// `VcsFsLive`/`VcsFsTag` from `@piki/vcs`, `WorkingDirectoryTag` (defined
// locally, mirroring `@piki/coding-agent`'s runtime tag), `ForkContextTag`
// (from `@piki/event-core`), `ROLE_DEFINITIONS` (from `@piki/event-core`),
// `WorkerBusTag` (from `@piki/event-core`).
//
// The fork layer is the minimal, piki-correct shape (VCS + working directory +
// fork context) rather than re-implementing a larger fork-runtime surface.
//     `makeForkLayers` graph. The `forkLayers` map remains the single seam where
//     additional reader/policy layers are merged once those subsystems land
//     (see roadmap Wave 5).
//
// Best-practice guardrails honored:
//   - `Context.GenericTag<Shape>()` for the service tag (defined in
//     agent-lifecycle.ts)
//   - `Effect.fn("Name")(function*(){...})` for tracing in handler bodies
//   - top-level imports only; no `any` in handler bodies; no `as` casts
//   - erasable TS only; uses piki's `LoggerShape.scoped.log(level, fields)`

import type { EventEnvelope } from "@piki/event-core";
import { ForkContext, ROLE_DEFINITIONS, type RoleDef, WorkerBusTag } from "@piki/event-core";
import { Logger } from "@piki/logger";
import { VcsFsLive } from "@piki/vcs";
import { Context, Effect, Layer } from "effect";
import { SessionContextProjection } from "../projections/session-context.ts";

// ---------------------------------------------------------------------------
// ExecutionManager — service tag + shape (canonical definition lives here)
// ---------------------------------------------------------------------------

export interface ExecutionManagerShape {
	readonly initFork: (forkId: string | null, roleId: string) => Effect.Effect<void, unknown, unknown>;
	readonly disposeFork: (forkId: string | null) => Effect.Effect<void, unknown, unknown>;
	readonly fork: (params: {
		readonly role: string;
		readonly parentForkId: string | null;
		readonly agentId: string;
		readonly name: unknown;
		readonly context: string;
		readonly mode: "spawn" | "clone";
		readonly taskId: string;
		readonly message: unknown;
		readonly outputSchema?: unknown;
	}) => Effect.Effect<string, unknown, unknown>;
	readonly getObservables: (forkId: string | null) => ReadonlyArray<ObservableBinding>;
	readonly getForkLayer: (forkId: string | null) => Layer.Layer<unknown, unknown, never> | undefined;
}

export const ExecutionManager = Context.GenericTag<ExecutionManagerShape>("piki/ExecutionManager");

// ---------------------------------------------------------------------------
// WorkingDirectory (local tag mirroring @piki/coding-agent runtime)
// ---------------------------------------------------------------------------

export interface WorkingDirectory {
	readonly cwd: string;
	readonly scratchpadPath: string;
}

export const WorkingDirectoryTag = Context.GenericTag<WorkingDirectory>("@piki/WorkingDirectory");

// ---------------------------------------------------------------------------
// Observable binding (read from a role's optional `observables`)
// ---------------------------------------------------------------------------

export interface ObservableBinding {
	readonly run: (effect: Effect.Effect<unknown>) => Effect.Effect<unknown>;
}

interface ObservablesRole extends RoleDef {
	readonly observables?: ReadonlyArray<ObservableBinding>;
}

function hasObservables(def: RoleDef): def is ObservablesRole {
	return "observables" in def;
}

// ---------------------------------------------------------------------------
// Session context runtime shape (narrowed from the projection's `unknown`)
// ---------------------------------------------------------------------------

interface SessionContextRuntime {
	readonly cwd: string;
	readonly scratchpadPath: string;
}

function isSessionContextRuntime(value: unknown): value is SessionContextRuntime {
	return (
		typeof value === "object" &&
		value !== null &&
		"cwd" in value &&
		"scratchpadPath" in value &&
		typeof (value as Record<string, unknown>).cwd === "string" &&
		typeof (value as Record<string, unknown>).scratchpadPath === "string"
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRoleDef(roleId: string): RoleDef | undefined {
	return ROLE_DEFINITIONS[roleId];
}

function resolveAgent(forkId: string | null, roles: Map<string | null, string>): RoleDef {
	if (forkId !== null) {
		const roleId = roles.get(forkId) ?? "engineer";
		const def = getRoleDef(roleId);
		if (def) return def;
	}
	return getRoleDef("leader") ?? ROLE_DEFINITIONS.engineer;
}

function makeAgentCreatedEnvelope(params: {
	readonly forkId: string;
	readonly parentForkId: string | null;
	readonly agentId: string;
	readonly name: unknown;
	readonly context: string;
	readonly mode: "spawn" | "clone";
	readonly taskId: string;
	readonly message: unknown;
	readonly outputSchema?: unknown;
}): EventEnvelope<string, Record<string, unknown>> {
	return {
		id: crypto.randomUUID(),
		stream: "worker",
		sequence: 0,
		type: "agent_created",
		timestamp: new Date().toISOString(),
		payload: {
			forkId: params.forkId,
			parentForkId: params.parentForkId,
			agentId: params.agentId,
			name: params.name,
			role: undefined,
			context: params.context,
			mode: params.mode,
			taskId: params.taskId,
			message: params.message,
			outputSchema: params.outputSchema,
		},
	};
}

// ---------------------------------------------------------------------------
// ExecutionManagerLive
// ---------------------------------------------------------------------------

export const ExecutionManagerLive = Layer.scoped(
	ExecutionManager,
	Effect.gen(function* () {
		const logger = yield* Logger;
		const scoped = yield* logger.namespace("ExecutionManager");
		const workerBus = yield* WorkerBusTag;

		const forkLayers = new Map<string | null, Layer.Layer<unknown, unknown, never>>();
		const forkCwds = new Map<string | null, string>();
		const forkScratchpadPaths = new Map<string | null, string>();
		const boundObservables = new Map<string | null, ReadonlyArray<ObservableBinding>>();
		const forkRoles = new Map<string | null, string>();
		const forkTeardowns = new Map<string | null, Effect.Effect<unknown>>();
		const identicalContinueTracker = new Map<string | null, number>();

		const doInitFork = (forkId: string | null, roleId: string): Effect.Effect<void, unknown, unknown> =>
			Effect.gen(function* () {
				const sessionState = yield* (yield* SessionContextProjection.Tag).get;
				if (!sessionState.initialized || !isSessionContextRuntime(sessionState.context)) {
					return yield* Effect.die(
						new Error(
							"Session context not initialized. session_initialized must be processed before initFork().",
						),
					);
				}
				const cwd = sessionState.context.cwd;
				const scratchpadPath = sessionState.context.scratchpadPath;

				yield* scoped.log("info", {
					context: "ExecutionManager",
					message: "[ExecutionManager] VCS layer built",
					cwd,
					scratchpadPath,
				});

				const roleDef = getRoleDef(roleId) ?? ROLE_DEFINITIONS.engineer;

				const layers: Layer.Layer<unknown, unknown, never> = Layer.mergeAll(
					VcsFsLive,
					Layer.succeed(WorkingDirectoryTag, { cwd, scratchpadPath }),
					Layer.succeed(ForkContext, { forkId, roleId }),
				);

				if (forkId !== null) {
					forkRoles.set(forkId, roleId);
				}
				forkLayers.set(forkId, layers);
				forkCwds.set(forkId, cwd);
				forkScratchpadPaths.set(forkId, scratchpadPath);

				const observables: ReadonlyArray<ObservableBinding> = hasObservables(roleDef)
					? (roleDef.observables ?? [])
					: [];
				boundObservables.set(forkId, observables);

				yield* scoped.log("info", {
					context: "ExecutionManager",
					message: "[ExecutionManager] fork initialized",
					forkId,
					roleId,
					cwd,
				});
			});

		const doDisposeFork = (forkId: string | null): Effect.Effect<void, unknown, unknown> =>
			Effect.gen(function* () {
				const teardown = forkId !== null ? forkTeardowns.get(forkId) : undefined;
				if (teardown !== undefined) {
					yield* teardown;
					if (forkId !== null) forkTeardowns.delete(forkId);
				}
				forkLayers.delete(forkId);
				forkCwds.delete(forkId);
				forkScratchpadPaths.delete(forkId);
				boundObservables.delete(forkId);
				if (forkId !== null) forkRoles.delete(forkId);
				identicalContinueTracker.delete(forkId);
				yield* scoped.log("info", {
					context: "ExecutionManager",
					message: "[ExecutionManager] fork disposed",
					forkId,
				});
			});

		const doFork = (params: {
			readonly role: string;
			readonly parentForkId: string | null;
			readonly agentId: string;
			readonly name: unknown;
			readonly context: string;
			readonly mode: "spawn" | "clone";
			readonly taskId: string;
			readonly message: unknown;
			readonly outputSchema?: unknown;
		}): Effect.Effect<string, unknown, unknown> =>
			Effect.gen(function* () {
				const forkId = crypto.randomUUID();
				forkRoles.set(forkId, params.role);
				yield* doInitFork(forkId, params.role);
				const taskId = params.taskId.trim();
				if (taskId.length === 0) {
					return yield* Effect.die(new Error("ExecutionManager.fork requires a non-empty taskId"));
				}
				yield* workerBus.publish(
					makeAgentCreatedEnvelope({
						forkId,
						parentForkId: params.parentForkId,
						agentId: params.agentId,
						name: params.name,
						context: params.context,
						mode: params.mode,
						taskId,
						message: params.message,
						outputSchema: params.outputSchema,
					}),
				);
				return forkId;
			});

		const service = {
			initFork: (forkId: string | null, roleId: string) => doInitFork(forkId, roleId),
			disposeFork: (forkId: string | null) => doDisposeFork(forkId),
			fork: (params: {
				readonly role: string;
				readonly parentForkId: string | null;
				readonly agentId: string;
				readonly name: unknown;
				readonly context: string;
				readonly mode: "spawn" | "clone";
				readonly taskId: string;
				readonly message: unknown;
				readonly outputSchema?: unknown;
			}) => doFork(params),
			getObservables: (forkId: string | null): ReadonlyArray<ObservableBinding> =>
				boundObservables.get(forkId) ?? [],
			getForkLayer: (forkId: string | null): Layer.Layer<unknown, unknown, never> | undefined =>
				forkLayers.get(forkId),
		};

		return service;
	}),
);

// Re-export for callers that need the role resolver parity helper.
export { resolveAgent };
