import { Context, Layer } from "effect";
import type { ProjectionStore } from "../projection.ts";

export interface ProjectionStoreTagShape {
	readonly store: ProjectionStore;
}

export const ProjectionStoreTag = Context.GenericTag<ProjectionStoreTagShape>("ProjectionStoreTag");

export function makeProjectionStoreLayer(store: ProjectionStore) {
	return Layer.succeed(ProjectionStoreTag, { store });
}
