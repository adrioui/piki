/**
 * Composes all storage services into a single ManagedRuntime.
 *
 * This stays in coding-agent because it depends on the auth-storage wrapper
 * (which depends on coding-agent internals like @piki/ai OAuth).
 */

import {
	type ConfigStorage,
	ConfigStorageLive,
	type FileMemoryStorage,
	type GlobalStorage,
	GlobalStorageLive,
	GlobalStorageLiveFromRoot,
	type LogStorage,
	LogStorageLive,
	MemoryStorageLive,
	type ProjectStorage,
	ProjectStorageLiveFromCwd,
	type SessionStorage,
	SessionStorageLive,
	type Version,
	VersionLive,
} from "@piki/storage";
import { Layer, ManagedRuntime } from "effect";
import { type AuthStorage, AuthStorageLive } from "./auth-storage.ts";

export type StorageClientRequirements =
	| AuthStorage
	| ConfigStorage
	| GlobalStorage
	| LogStorage
	| FileMemoryStorage
	| ProjectStorage
	| SessionStorage
	| Version;

export interface StorageClient {
	runtime: ManagedRuntime.ManagedRuntime<StorageClientRequirements, never>;
	layer: Layer.Layer<StorageClientRequirements, never, never>;
}

export interface CreateStorageClientOptions {
	cwd: string;
	version: string;
	globalRoot?: string;
}

export function createStorageClient(options: CreateStorageClientOptions): StorageClient {
	const foundation = Layer.mergeAll(
		options.globalRoot ? GlobalStorageLiveFromRoot(options.globalRoot) : GlobalStorageLive,
		ProjectStorageLiveFromCwd(options.cwd),
		VersionLive(options.version),
	);
	const layer = Layer.mergeAll(
		foundation,
		AuthStorageLive.pipe(Layer.provide(foundation)),
		ConfigStorageLive.pipe(Layer.provide(foundation)),
		LogStorageLive.pipe(Layer.provide(foundation)),
		MemoryStorageLive.pipe(Layer.provide(foundation)),
		SessionStorageLive.pipe(Layer.provide(foundation)),
	);
	return {
		layer,
		runtime: ManagedRuntime.make(layer),
	};
}
