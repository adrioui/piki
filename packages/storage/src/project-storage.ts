import { Context, Layer } from "effect";
import { makeProjectStoragePaths, type ProjectStoragePaths } from "./paths.ts";

export interface ProjectStorage {
	cwd: string;
	root: string;
	paths: ProjectStoragePaths;
}

function makeProjectStorage(options: { cwd: string }): ProjectStorage {
	const paths = makeProjectStoragePaths(options.cwd);
	return { cwd: options.cwd, root: paths.root, paths };
}

export function ProjectStorageLiveFromCwd(cwd: string) {
	return Layer.succeed(ProjectStorageTag, ProjectStorageTag.of(makeProjectStorage({ cwd })));
}

export const ProjectStorageTag = Context.GenericTag<ProjectStorage>("@piki/ProjectStorage");

export const ProjectStorageLiveFromProcessCwd = ProjectStorageLiveFromCwd(process.cwd());
