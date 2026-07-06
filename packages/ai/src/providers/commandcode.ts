import type * as NodeFs from "node:fs";
import type * as NodeOs from "node:os";
import { commandCodeApi } from "../api/commandcode.lazy.ts";
import type { ApiKeyAuth, AuthLoginCallbacks, OAuthAuth, OAuthCredential } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { loginCommandCode, refreshCommandCodeToken } from "../utils/oauth/commandcode.ts";
import { COMMANDCODE_MODELS } from "./commandcode.models.ts";
import { fetchCommandCodeModels } from "./commandcode-catalog.ts";

let nodeFs: typeof NodeFs | undefined;
let nodeOs: typeof NodeOs | undefined;

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_FS_SPECIFIER = "node:" + "fs";
const NODE_OS_SPECIFIER = "node:" + "os";

async function loadNodeAuthModules(): Promise<{ fs: typeof NodeFs; os: typeof NodeOs } | undefined> {
	if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) return undefined;
	nodeFs ??= (await dynamicImport(NODE_FS_SPECIFIER)) as typeof NodeFs;
	nodeOs ??= (await dynamicImport(NODE_OS_SPECIFIER)) as typeof NodeOs;
	return { fs: nodeFs, os: nodeOs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function credentialRecordApiKey(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const type = stringValue(value.type);
	if (type === "api_key" || type === "api") return stringValue(value.key);
	if (type === "oauth") return stringValue(value.access);
	return stringValue(value.key) ?? stringValue(value.access);
}

async function readApiKeyFromFile(fs: typeof NodeFs, path: string): Promise<string | undefined> {
	try {
		if (!fs.existsSync(path)) return undefined;
		const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf-8"));
		if (!isRecord(parsed)) return undefined;
		return (
			stringValue(parsed.apiKey) ??
			stringValue(parsed.commandcode) ??
			credentialRecordApiKey(parsed.commandcode) ??
			credentialRecordApiKey(parsed["command-code"])
		);
	} catch {
		return undefined;
	}
}

function commandCodeAuth(): ApiKeyAuth {
	return {
		name: "Command Code API key",
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: "Enter Command Code API key" });
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			const baseUrl = (await ctx.env("COMMANDCODE_API_BASE")) || undefined;
			const credentialKey = credential?.key;
			if (credentialKey) return { auth: { apiKey: credentialKey, baseUrl }, source: "stored credential" };
			const envKey = await ctx.env("COMMANDCODE_API_KEY");
			if (envKey) return { auth: { apiKey: envKey, baseUrl }, source: "COMMANDCODE_API_KEY" };

			const modules = await loadNodeAuthModules();
			if (!modules) return undefined;
			const home = modules.os.homedir();
			const authPaths = [
				`${home}/.commandcode/auth.json`,
				`${home}/.pi/agent/auth.json`,
				`${home}/.omp/agent/auth.json`,
			];
			for (const path of authPaths) {
				const fileKey = await readApiKeyFromFile(modules.fs, path);
				if (fileKey) return { auth: { apiKey: fileKey, baseUrl }, source: path };
			}
			return undefined;
		},
	};
}

function toLegacyCallbacks(callbacks: AuthLoginCallbacks) {
	return {
		signal: callbacks.signal,
		onAuth: (info: { url: string; instructions?: string }) =>
			callbacks.notify({ type: "auth_url", url: info.url, instructions: info.instructions }),
		onDeviceCode: (info: {
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}) => callbacks.notify({ type: "device_code", ...info }),
		onPrompt: (prompt: { message: string; placeholder?: string }) =>
			callbacks.prompt({ type: "manual_code", message: prompt.message, placeholder: prompt.placeholder }),
		onSelect: (prompt: { message: string; options: { id: string; label: string }[] }) =>
			callbacks.prompt({
				type: "select",
				message: prompt.message,
				options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
			}),
		onProgress: (message: string) => callbacks.notify({ type: "progress", message }),
	};
}

function commandCodeOAuth(): OAuthAuth {
	return {
		name: "Command Code subscription",
		login: async (callbacks) => ({ type: "oauth", ...(await loginCommandCode(toLegacyCallbacks(callbacks))) }),
		refresh: async (credential) => ({
			type: "oauth",
			...(await refreshCommandCodeToken(credential)),
		}),
		toAuth: async (credential: OAuthCredential) => ({
			apiKey: credential.access,
			baseUrl: typeof process === "undefined" ? undefined : process.env.COMMANDCODE_API_BASE || undefined,
		}),
	};
}

export function commandCodeProvider(): Provider<"commandcode"> {
	return createProvider({
		id: "commandcode",
		name: "Command Code",
		auth: { apiKey: commandCodeAuth(), oauth: commandCodeOAuth() },
		models: Object.values(COMMANDCODE_MODELS),
		refreshModels: async () => fetchCommandCodeModels({ url: process.env.COMMANDCODE_MODELS_URL }),
		api: commandCodeApi(),
	});
}
