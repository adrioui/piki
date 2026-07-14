/**
 * Effect wrapper around the core AuthStorage class.
 *
 * This stays in coding-agent because it depends on coding-agent internals:
 * - ../auth-storage.ts (the legacy AuthStorage class with OAuth, file locking)
 * - @piki/ai (OAuth provider types)
 */

import { GlobalStorageTag } from "@piki/storage";
import { Context, Effect, Layer } from "effect";
import { type AuthCredential, type AuthStorageData, AuthStorage as LegacyAuthStorage } from "../auth-storage.ts";

export interface AuthStorage {
	loadAll: Effect.Effect<AuthStorageData>;
	get: (provider: string) => Effect.Effect<AuthCredential | undefined>;
	set: (provider: string, credential: AuthCredential) => Effect.Effect<void>;
	remove: (provider: string) => Effect.Effect<void>;
}

export const AuthStorageTag = Context.GenericTag<AuthStorage>("@piki/StorageAuthStorage");

function makeAuthStorage(authFile: string): AuthStorage {
	const legacy = LegacyAuthStorage.create(authFile);
	return {
		loadAll: Effect.sync(() => legacy.getAll()),
		get: (provider) => Effect.sync(() => legacy.getAll()[provider]),
		set: (provider, credential) =>
			Effect.sync(() => {
				legacy.set(provider, credential);
			}),
		remove: (provider) =>
			Effect.sync(() => {
				legacy.remove(provider);
			}),
	};
}

export const AuthStorageLive = Layer.scoped(
	AuthStorageTag,
	Effect.map(GlobalStorageTag, (globalStorage) => AuthStorageTag.of(makeAuthStorage(globalStorage.paths.authFile))),
);
