/**
 * Storage services for coding-agent.
 *
 * Pure storage modules live in @piki/storage.
 * These two files remain here because they depend on coding-agent internals
 * (@piki/ai OAuth, core/auth-storage.ts legacy class).
 */

export {
	ConfigStorageTag,
	LogStorageTag,
	MemoryStorageTag,
	SCRATCHPAD_SUBDIRS,
	SessionStorageTag,
} from "@piki/storage";
export * from "./auth-storage.ts";
export * from "./storage-client.ts";
