import { Layer, ManagedRuntime } from "effect";
import type { ProjectionStore } from "../projection.ts";
import type { RoleHost } from "../role.ts";
import type { DefaultEventSink } from "../sink.ts";
import { AmbientLive, type AmbientShape } from "./ambient-service.ts";
import { type EventSinkTagShape, makeEventSinkLayer } from "./event-sink-tag.ts";
import {
	FrameworkErrorPubSubLive,
	type FrameworkErrorPubSubShape,
	FrameworkErrorReporterLive,
	type FrameworkErrorReporterShape,
} from "./framework-error.ts";
import { HydrationContextLive, type HydrationContextShape } from "./hydration-context.ts";
import { ProjectionBusLive, type ProjectionBusShape } from "./projection-bus.ts";
import { makeProjectionStoreLayer, type ProjectionStoreTagShape } from "./projection-store-tag.ts";
import { makeRoleHostLayer, type RoleHostTagShape } from "./role-host-tag.ts";
import { TraceBusLive, type TraceBusShape } from "./trace-bus.ts";

// ---------------------------------------------------------------------------
// Foundation deps — concrete instances the caller must provide
// ---------------------------------------------------------------------------

export interface FoundationDeps {
	readonly sink: DefaultEventSink;
	readonly projectionStore: ProjectionStore;
	readonly roleHost: RoleHost;
}

// ---------------------------------------------------------------------------
// Union of all service tags provided by the foundation layer
// ---------------------------------------------------------------------------

export type FoundationRequirements =
	| AmbientShape
	| EventSinkTagShape
	| FrameworkErrorPubSubShape
	| FrameworkErrorReporterShape
	| TraceBusShape
	| ProjectionBusShape
	| ProjectionStoreTagShape
	| RoleHostTagShape
	| HydrationContextShape;

// ---------------------------------------------------------------------------
// Layer composition
// ---------------------------------------------------------------------------

/**
 * Compose all foundation layers into a single `Layer.Layer`.
 *
 * `FrameworkErrorReporterLive` requires `FrameworkErrorPubSub`, so we use
 * `Layer.provideMerge` to supply the PubSub from the same live instance and
 * retain both services in the output layer (avoids creating two PubSubs).
 */
export function buildFoundationLayer(deps: FoundationDeps): Layer.Layer<FoundationRequirements, never, never> {
	const frameworkErrorLayer = FrameworkErrorReporterLive.pipe(Layer.provideMerge(FrameworkErrorPubSubLive));

	return Layer.mergeAll(
		HydrationContextLive,
		frameworkErrorLayer,
		TraceBusLive,
		ProjectionBusLive.pipe(Layer.provide(frameworkErrorLayer)),
		makeEventSinkLayer(deps.sink),
		makeProjectionStoreLayer(deps.projectionStore),
		makeRoleHostLayer(deps.roleHost),
		AmbientLive,
	);
}

// ---------------------------------------------------------------------------
// ManagedRuntime constructor
// ---------------------------------------------------------------------------

/**
 * Build a `ManagedRuntime` from the foundation layer.
 * Callers should hold on to the returned runtime and `dispose()` it when done.
 */
export function makeFoundationRuntime(
	deps: FoundationDeps,
): ManagedRuntime.ManagedRuntime<FoundationRequirements, never> {
	return ManagedRuntime.make(buildFoundationLayer(deps));
}
