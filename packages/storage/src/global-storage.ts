import { Context, Layer } from "effect";
import { defaultGlobalStorageRoot, type GlobalStoragePaths, makeGlobalStoragePaths } from "./paths.ts";

export interface GlobalStorage {
	root: string;
	paths: GlobalStoragePaths;
}

function makeGlobalStorage(options?: { root?: string }): GlobalStorage {
	const root = options?.root ?? defaultGlobalStorageRoot();
	return { root, paths: makeGlobalStoragePaths(root) };
}

export const GlobalStorageTag = Context.GenericTag<GlobalStorage>("@piki/GlobalStorage");

export function GlobalStorageLiveFromRoot(root: string) {
	return Layer.succeed(GlobalStorageTag, GlobalStorageTag.of(makeGlobalStorage({ root })));
}

export const GlobalStorageLive = GlobalStorageLiveFromRoot(defaultGlobalStorageRoot());
