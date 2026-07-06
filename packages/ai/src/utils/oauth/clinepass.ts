import type * as NodeFs from "node:fs";
import type * as NodeOs from "node:os";
import type * as NodePath from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const CLINEPASS_DASHBOARD_URL = "https://app.cline.bot/settings/api-keys";
const CLINEPASS_REFRESH_ENDPOINT = "/api/v1/auth/refresh";
const CLINEPASS_TOKEN_LIFETIME_MS = 55 * 60 * 1000;
const CLINEPASS_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const WORKOS_TOKEN_PREFIX = "workos:";
const NODE_FS_SPECIFIER = "node:" + "fs";
const NODE_OS_SPECIFIER = "node:" + "os";
const NODE_PATH_SPECIFIER = "node:" + "path";

let nodeFs: typeof NodeFs | undefined;
let nodeOs: typeof NodeOs | undefined;
let nodePath: typeof NodePath | undefined;

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);

async function loadNodeModules(): Promise<{ fs: typeof NodeFs; os: typeof NodeOs; path: typeof NodePath } | undefined> {
	if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) return undefined;
	nodeFs ??= (await dynamicImport(NODE_FS_SPECIFIER)) as typeof NodeFs;
	nodeOs ??= (await dynamicImport(NODE_OS_SPECIFIER)) as typeof NodeOs;
	nodePath ??= (await dynamicImport(NODE_PATH_SPECIFIER)) as typeof NodePath;
	return { fs: nodeFs, os: nodeOs, path: nodePath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function sanitizeApiKey(input: string): string {
	const esc = String.fromCharCode(27);
	return Array.from(
		input.replaceAll(`${esc}[200~`, "").replaceAll(`${esc}[201~`, "").replaceAll("[200~", "").replaceAll("[201~", ""),
	)
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code > 31 && code !== 127;
		})
		.join("")
		.trim();
}

function clineAuthPaths(modules: { os: typeof NodeOs; path: typeof NodePath }): string[] {
	const home = modules.os.homedir();
	return [modules.path.join(home, ".cline", "data", "settings", "providers.json")];
}

function credentialsFromApiKey(apiKey: string): OAuthCredentials {
	return {
		refresh: apiKey,
		access: apiKey,
		expires: Date.now() + TEN_YEARS_MS,
	};
}

function credentialsFromWorkos(accessToken: string, refreshToken: string, expiresAt: number): OAuthCredentials {
	return {
		access: accessToken.startsWith(WORKOS_TOKEN_PREFIX) ? accessToken : `${WORKOS_TOKEN_PREFIX}${accessToken}`,
		refresh: refreshToken,
		expires: expiresAt,
	};
}

async function resolveClineAuthCredentials(): Promise<OAuthCredentials | undefined> {
	const modules = await loadNodeModules();
	if (!modules) return undefined;
	for (const authPath of clineAuthPaths(modules)) {
		try {
			if (!modules.fs.existsSync(authPath)) continue;
			const parsed: unknown = JSON.parse(modules.fs.readFileSync(authPath, "utf-8"));
			if (!isRecord(parsed)) continue;
			const providers = isRecord(parsed.providers) ? parsed.providers : undefined;
			if (!providers) continue;
			for (const providerKey of ["cline-pass", "cline"]) {
				const provider = isRecord(providers[providerKey]) ? providers[providerKey] : undefined;
				const settings = isRecord(provider?.settings) ? provider.settings : undefined;
				const auth = isRecord(settings?.auth) ? settings.auth : undefined;
				const accessToken = stringValue(auth?.accessToken);
				const refreshToken = stringValue(auth?.refreshToken);
				if (!accessToken || !refreshToken) continue;
				const expiresAt =
					typeof auth?.expiresAt === "number" && Number.isFinite(auth.expiresAt)
						? auth.expiresAt
						: Date.now() + CLINEPASS_TOKEN_LIFETIME_MS;
				return credentialsFromWorkos(accessToken, refreshToken, expiresAt);
			}
		} catch {}
	}
	return undefined;
}

async function refreshClinePassToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (!credentials.access.startsWith(WORKOS_TOKEN_PREFIX)) return credentialsFromApiKey(credentials.refresh);

	const response = await fetch(`${clinePassApiBase()}${CLINEPASS_REFRESH_ENDPOINT}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			granttype: "refresh_token",
			refreshToken: credentials.refresh,
		}),
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "unknown error");
		throw new Error(`ClinePass token refresh failed (${response.status}): ${text}`);
	}

	const data = (await response.json()) as {
		data?: { accessToken?: string; refreshToken?: string };
		accessToken?: string;
		refreshToken?: string;
	};
	const tokens = data.data ?? data;
	if (!tokens.accessToken || !tokens.refreshToken) {
		throw new Error("ClinePass token refresh returned unexpected response format");
	}

	return credentialsFromWorkos(
		tokens.accessToken,
		tokens.refreshToken,
		Date.now() + CLINEPASS_TOKEN_LIFETIME_MS - CLINEPASS_REFRESH_MARGIN_MS,
	);
}

export function clinePassApiBase(): string {
	const base = process.env.CLINE_API_BASE?.trim();
	return (base || "https://api.cline.bot").replace(/\/+$/, "");
}

export async function loginClinePass(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const clineAuth = await resolveClineAuthCredentials();
	if (clineAuth) {
		if (clineAuth.expires <= Date.now() + CLINEPASS_REFRESH_MARGIN_MS) return refreshClinePassToken(clineAuth);
		return clineAuth;
	}

	callbacks.onAuth({
		url: CLINEPASS_DASHBOARD_URL,
		instructions: "Subscribe to ClinePass or run `cline auth`, then paste a ClinePass API key if needed.",
	});
	const apiKey = sanitizeApiKey(
		await callbacks.onPrompt({
			message:
				"No Cline CLI subscription login was detected. Paste a ClinePass API key, or cancel and run `cline auth` first:",
		}),
	);
	if (!apiKey) throw new Error("No ClinePass API key provided");
	return credentialsFromApiKey(apiKey);
}

export const clinePassOAuthProvider: OAuthProviderInterface = {
	id: "clinepass",
	name: "ClinePass",
	login: loginClinePass,
	refreshToken: refreshClinePassToken,
	getApiKey: (credentials) => credentials.access,
};
