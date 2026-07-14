export { type AmbDef, define as defineAmbient } from "./ambient/define.ts";
export {
	canAssignRecord,
	canCompleteRecord,
	canCompleteTask,
	createCheckpointProjection,
	createGoalProjection,
	createTaskGraphProjection,
	GoalSignals,
	type GoalState,
	type GoalStatus,
	isTaskStatus,
	TASK_STATUSES,
	type Task,
	TaskGraphSignals,
	type TaskGraphState,
	type TaskStatus,
} from "./builtin.ts";
export * from "./builtin-extended.ts";
export { createUserMessageResolutionProjection } from "./compat.ts";
export {
	CHARS_PER_TOKEN_LOWER,
	CHARS_PER_TOKEN_UPPER,
	COMPACT_MAX_FILE_CHARS,
	COMPACT_MAX_FILES,
	COMPACTION_FALLBACK_KEEP_RATIO,
	COMPACTION_MAX_RETRIES,
	calculateContextCaps,
	DEFAULT_CONTEXT_LIMIT_POLICY,
	KEEP_MESSAGE_RATIO,
	OUTPUT_TOKEN_RESERVE,
	TRUNCATION_CHAR_LIMIT,
	TRUNCATION_TOKEN_LIMIT,
} from "./constants.ts";
export {
	type AmbientDef,
	type AmbientServiceShape,
	AmbientServiceTag,
	makeAmbientServiceLayer,
	UnregisteredAmbientDefect,
} from "./core/ambient-service.ts";
export {
	type EventBusCoreShape,
	EventBusCoreTag,
	makeEventBusCoreLayer,
} from "./core/event-bus-core.ts";
export { type EventSinkShape, EventSinkTag, makeEventSinkLayer } from "./core/event-sink.ts";
export {
	FrameworkError,
	FrameworkErrorPubSub,
	FrameworkErrorPubSubLive,
	type FrameworkErrorPubSubShape,
	FrameworkErrorReporter,
	FrameworkErrorReporterLive,
	type FrameworkErrorReporterShape,
} from "./core/framework-error.ts";
export {
	HydrationContext,
	HydrationContextLive,
	HydrationContextNoop,
	type HydrationContextShape,
} from "./core/hydration-context.ts";
export {
	InterruptCoordinator,
	InterruptCoordinatorLive,
	type InterruptCoordinatorShape,
} from "./core/interrupt-coordinator.ts";
export {
	makeProjectionBusLayer,
	ProjectionBus,
	type ProjectionBusShape,
} from "./core/projection-bus.ts";
export {
	makeWorkerBusLayer,
	type WorkerBusShape,
	WorkerBusTag,
} from "./core/worker-bus.ts";
export {
	createManagedClient,
	type EngineService,
	type ManagedClient,
	make as makeEventEngine,
	Service as EventEngineService,
} from "./event-engine/index.ts";
export { ForkContext } from "./fork/context.ts";
export {
	type AgentCreatedPayload,
	buildForkContext,
	createAgentCreatedEvent,
	type ForkContextInput,
	type ForkMode,
	type ForkRecord,
	ForkRegistry,
} from "./fork.ts";
export { ForkedProjectionStore } from "./forked-projection.ts";
export { defineFSM } from "./fsm/define.ts";
export type { ProjectionDefinition as EffectProjectionDefinition } from "./projection/index.ts";
export {
	type AmbientHandlerContext,
	define as defineProjection,
	defineForked as defineForkedProjection,
	type EventHandlerContext,
	type ForkedEventHandlerContext,
	type ForkedProjectionConfig,
	type ForkedProjectionDefinition,
	type GlobalEventHandlerContext,
	type ProjectionConfig,
	type ProjectionRef,
	type SignalHandlerContext,
} from "./projection/index.ts";
export { ProjectionStore } from "./projection.ts";
export { InMemorySignalBus, RoleHost, type RoleHostOptions } from "./role.ts";
export {
	type ContextLens,
	DEFAULT_CONTEXT_LENS,
	getRoleContextLens,
	type ModelTier,
	ROLE_DEFINITIONS,
	type RoleDef,
	SPAWNABLE_ROLES,
} from "./roles.ts";
export {
	create,
	createSignal,
	emit as signalEmit,
	fromDef,
	Signal as EffectSignal,
	stream as signalStream,
} from "./signal/define.ts";
export { DefaultEventSink, type DefaultEventSinkOptions } from "./sink.ts";
// Legacy compat layer: these classes/factories back the existing tests and
// integrations (coding-agent, agent). They are re-exported from their original
// source modules so the public surface stays stable.
export { InMemoryEventStore, JsonlEventStore } from "./store.ts";
export {
	command,
	effectClient,
	host as surfaceHost,
	signal as surfaceSignal,
	state as surfaceState,
	vanillaClient,
} from "./surface/index.ts";
export type {
	EventEnvelope,
	EventListOptions,
	EventSink,
	EventStore,
	ProjectionDefinition,
	ProjectionSnapshot,
	ProjectionView,
	RoleContext,
	RoleDefinition,
	Signal,
	SignalBus,
	SignalDefinition,
} from "./types.ts";
export { defineForked as defineForkedWorker, type ForkedWorkerDefinition } from "./worker/defineForked.ts";
export { define as defineWorker, type WorkerDefinition, type WorkerReadFn } from "./worker/index.ts";
export * from "./workers.ts";
