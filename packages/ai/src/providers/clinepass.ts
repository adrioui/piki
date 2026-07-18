import type * as NodeFs from "node:fs";
import type * as NodeOs from "node:os";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth, AuthLoginCallbacks, OAuthAuth, OAuthCredential } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { clinePassOAuthProvider, loginClinePass } from "../utils/oauth/clinepass.ts";
import { CLINEPASS_MODELS } from "./clinepass.models.ts";
import { CLINEPASS_API_KEY_ENV, clinePassApiBase, fetchClinePassModels } from "./clinepass-catalog.ts";

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
	const access = stringValue(value.access);
	if (access?.startsWith("workos:")) return undefined;
	return stringValue(value.key) ?? access;
}

function clineProviderSettingsApiKey(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const providers = isRecord(value.providers) ? value.providers : undefined;
	if (!providers) return undefined;
	for (const providerKey of ["cline-pass", "cline"]) {
		const provider = isRecord(providers[providerKey]) ? providers[providerKey] : undefined;
		const settings = isRecord(provider?.settings) ? provider.settings : undefined;
		const apiKey = stringValue(settings?.apiKey);
		if (apiKey) return apiKey;
	}
	return undefined;
}

async function readApiKeyFromFile(fs: typeof NodeFs, path: string): Promise<string | undefined> {
	try {
		if (!fs.existsSync(path)) return undefined;
		const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf-8"));
		if (!isRecord(parsed)) return undefined;
		return (
			clineProviderSettingsApiKey(parsed) ??
			stringValue(parsed.apiKey) ??
			stringValue(parsed.clinepass) ??
			credentialRecordApiKey(parsed.clinepass)
		);
	} catch {
		return undefined;
	}
}

function clinePassAuth(): ApiKeyAuth {
	return {
		name: "ClinePass API key",
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: "Enter ClinePass API key" });
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			const credentialKey = credential?.key;
			if (credentialKey)
				return {
					auth: { apiKey: credentialKey, baseUrl: `${clinePassApiBase()}/api/v1` },
					source: "stored credential",
				};

			const envKey = await ctx.env(CLINEPASS_API_KEY_ENV);
			if (envKey)
				return { auth: { apiKey: envKey, baseUrl: `${clinePassApiBase()}/api/v1` }, source: CLINEPASS_API_KEY_ENV };

			const modules = await loadNodeAuthModules();
			if (!modules) return undefined;
			const home = modules.os.homedir();
			const authPaths = [`${home}/.cline/data/settings/providers.json`, `${home}/.pi/agent/auth.json`];
			for (const path of authPaths) {
				const fileKey = await readApiKeyFromFile(modules.fs, path);
				if (fileKey) return { auth: { apiKey: fileKey, baseUrl: `${clinePassApiBase()}/api/v1` }, source: path };
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

function clinePassOAuth(): OAuthAuth {
	return {
		name: "ClinePass subscription",
		login: async (callbacks) => ({ type: "oauth", ...(await loginClinePass(toLegacyCallbacks(callbacks))) }),
		refresh: async (credential) => ({
			type: "oauth",
			...(await clinePassOAuthProvider.refreshToken(credential)),
		}),
		toAuth: async (credential: OAuthCredential) => ({
			apiKey: credential.access,
			baseUrl: `${clinePassApiBase()}/api/v1`,
		}),
	};
}

export function clinePassProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "clinepass",
		name: "ClinePass",
		baseUrl: `${clinePassApiBase()}/api/v1`,
		auth: { apiKey: clinePassAuth(), oauth: clinePassOAuth() },
		models: Object.values(CLINEPASS_MODELS),
		refreshModels: async () => fetchClinePassModels(),
		api: openAICompletionsApi(),
	});
}
