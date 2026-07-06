import { Context, Layer } from "effect";
import type { ProjectionStore } from "../projection.ts";

export interface ProjectionStoreTagShape {
	readonly store: ProjectionStore;
}

export class ProjectionStoreTag extends Context.Service<ProjectionStoreTag, ProjectionStoreTagShape>()(
	"ProjectionStoreTag",
) {}

export function makeProjectionStoreLayer(store: ProjectionStore): Layer.Layer<ProjectionStoreTag, never, never> {
	return Layer.succeed(ProjectionStoreTag, { store });
}
