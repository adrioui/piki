import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import { GlobalStorageTag } from "./global-storage.ts";

export interface ContextLimitPolicy {
	softCapRatio?: number;
	softCapMaxTokens?: number;
}

export interface StoredConfig {
	contextLimitPolicy?: ContextLimitPolicy;
	[key: string]: unknown;
}

export class ConfigStorageError extends Data.TaggedError("ConfigStorageError")<{
	readonly operation: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export interface ConfigStorage {
	load: Effect.Effect<StoredConfig, ConfigStorageError>;
	save: (config: StoredConfig) => Effect.Effect<void, ConfigStorageError>;
	update: (f: (config: StoredConfig) => StoredConfig) => Effect.Effect<StoredConfig, ConfigStorageError>;
	getContextLimitPolicy: Effect.Effect<ContextLimitPolicy | undefined, ConfigStorageError>;
	setContextLimitPolicy: (policy: ContextLimitPolicy | undefined) => Effect.Effect<void, ConfigStorageError>;
}

export const ConfigStorageTag = Context.GenericTag<ConfigStorage>("@piki/StorageConfigStorage");

function parseConfig(raw: string): StoredConfig {
	const parsed = JSON.parse(raw) as unknown;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as StoredConfig) : {};
}

function makeConfigStorage(configFile: string): ConfigStorage {
	const load = Effect.tryPromise({
		try: async () => {
			try {
				return parseConfig(await readFile(configFile, "utf8"));
			} catch (error) {
				if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
				throw error;
			}
		},
		catch: (cause) =>
			new ConfigStorageError({ operation: "load", message: `Failed to load config from ${configFile}`, cause }),
	});
	const save = (config: StoredConfig) =>
		Effect.tryPromise({
			try: async () => {
				await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
				await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			},
			catch: (cause) =>
				new ConfigStorageError({ operation: "save", message: `Failed to save config to ${configFile}`, cause }),
		});
	const update = (f: (config: StoredConfig) => StoredConfig) =>
		Effect.flatMap(load, (config) => {
			const next = f(config);
			return Effect.as(save(next), next);
		});
	return {
		load,
		save,
		update,
		getContextLimitPolicy: Effect.map(load, (config) => config.contextLimitPolicy),
		setContextLimitPolicy: (policy) =>
			Effect.as(
				update((config) => {
					if (policy === undefined) {
						const { contextLimitPolicy: _contextLimitPolicy, ...rest } = config;
						return rest;
					}
					return { ...config, contextLimitPolicy: policy };
				}),
				undefined,
			),
	};
}

export const ConfigStorageLive = Layer.scoped(
	ConfigStorageTag,
	Effect.map(GlobalStorageTag, (globalStorage) =>
		ConfigStorageTag.of(makeConfigStorage(globalStorage.paths.configFile)),
	),
);
