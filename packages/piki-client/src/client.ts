import { type HttpBody, HttpClient, type HttpClientError, HttpClientRequest } from "@effect/platform";
import { Auth } from "@piki/ai";
import { Context, Duration, Effect } from "effect";
import { createModelCatalog } from "./catalog.ts";
import {
	CLIENT_PLATFORM,
	CLIENT_SHELL,
	HEADER_PLATFORM,
	HEADER_SESSION_ID,
	HEADER_SHELL,
	HEADER_USE_DEDICATED,
} from "./client-headers.ts";
import { isEnvFlagOn } from "./env.ts";
import { type BoundPikiModel, bindWithPikiOptions, createPikiCompatibleSpec, createRoleSpec } from "./models.ts";

const DEFAULT_ENDPOINT = "https://app.piki.dev/api/v1";
const LOCAL_ENDPOINT = "http://localhost:3000/api/v1";

/**
 * piki server client — role-based model routing via app.piki.dev.
 */
export class WebSearchError {
	message: string;
	_tag = "WebSearchError";
	constructor(message: string) {
		this.message = message;
	}
}

export function createPikiClient(config?: {
	apiKey?: string;
	endpoint?: string;
	sessionId?: string | null;
	dedicatedProvider?: string;
}) {
	const useLocal = isEnvFlagOn(process.env.PIKI_USE_LOCAL);
	const apiKey = config?.apiKey ?? (useLocal ? process.env.PIKI_LOCAL_API_KEY : undefined) ?? process.env.PIKI_API_KEY;
	if (!apiKey) {
		throw new Error(
			useLocal
				? "No API key provided. Set PIKI_LOCAL_API_KEY (or PIKI_API_KEY) environment variable, or pass apiKey in config."
				: "No API key provided. Pass apiKey in config or set PIKI_API_KEY environment variable.",
		);
	}
	const endpoint = config?.endpoint ?? (useLocal ? LOCAL_ENDPOINT : DEFAULT_ENDPOINT);
	const sessionId = config?.sessionId ?? null;
	const dedicatedProvider = config?.dedicatedProvider || process.env.PIKI_USE_DEDICATED || undefined;
	const auth = Auth.bearer(apiKey);
	const authWithHeaders = (headers: Headers) => {
		auth(headers);
		headers.set(HEADER_PLATFORM, CLIENT_PLATFORM);
		headers.set(HEADER_SHELL, CLIENT_SHELL);
		if (sessionId) headers.set(HEADER_SESSION_ID, sessionId);
		if (dedicatedProvider) headers.set(HEADER_USE_DEDICATED, dedicatedProvider);
	};
	const catalog = createModelCatalog({ endpoint, auth: authWithHeaders });

	function webSearch<TData>(query: string, schema?: unknown) {
		return Effect.gen(function* () {
			const http = yield* HttpClient.HttpClient;
			const headers = new Headers();
			authWithHeaders(headers);
			const headerRecord: Record<string, string> = {};
			headers.forEach((value, key) => {
				headerRecord[key] = value;
			});
			headerRecord["Content-Type"] = "application/json";
			const body: { query: string; schema?: unknown } = schema ? { query, schema } : { query };
			const request = HttpClientRequest.post(`${endpoint}/web-search`).pipe(
				HttpClientRequest.setHeaders(headerRecord),
			);
			const requestWithBody = yield* HttpClientRequest.bodyJson(body)(request).pipe(
				Effect.mapError(
					(err: HttpBody.HttpBodyError) => new WebSearchError(`Failed to encode request body: ${err}`),
				),
			);
			const response = yield* http.execute(requestWithBody).pipe(
				Effect.mapError((err: HttpClientError.HttpClientError) => new WebSearchError(`Request failed: ${err}`)),
				Effect.timeoutFail({
					onTimeout: () => new WebSearchError("Request timed out after 10 seconds"),
					duration: Duration.seconds(10),
				}),
			);
			if (response.status < 200 || response.status >= 300) {
				const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
				return yield* Effect.fail(new WebSearchError(`HTTP ${response.status}: ${text}`));
			}
			const text = yield* response.text.pipe(
				Effect.mapError(
					(err: HttpClientError.HttpClientError) => new WebSearchError(`Failed to read response: ${err}`),
				),
			);
			let parsed: { text: string; sources: unknown; data: TData };
			try {
				parsed = JSON.parse(text);
			} catch {
				return yield* Effect.fail(new WebSearchError(`Failed to parse response: ${text.slice(0, 200)}`));
			}
			return {
				text: parsed.text,
				sources: parsed.sources,
				data: parsed.data,
			};
		});
	}

	return {
		auth: authWithHeaders,
		catalog,
		sessionId,
		role: (
			id: string,
			options?: {
				capabilities?: { vision?: boolean; grammar?: boolean };
				defaults?: Record<string, unknown>;
				imagePlaceholders?: { enabled: boolean; format: (part: unknown) => string };
			},
		) => {
			const spec = createRoleSpec(id, endpoint, options?.capabilities);
			const baseOptions = sessionId ? { session_id: sessionId } : ({} as Record<string, unknown>);
			const bound = spec.bind({
				auth: authWithHeaders,
				defaults: options?.defaults ?? ({} as Record<string, unknown>),
				imagePlaceholders: options?.imagePlaceholders,
			});
			return bindWithPikiOptions(bound as BoundPikiModel, baseOptions);
		},
		model: (
			id: string,
			options?: {
				defaults?: Record<string, unknown>;
				imagePlaceholders?: { enabled: boolean; format: (part: unknown) => string };
			},
		) => {
			const spec = createPikiCompatibleSpec({ modelId: id, endpoint });
			const baseOptions = sessionId ? { session_id: sessionId } : ({} as Record<string, unknown>);
			const bound = spec.bind({
				auth: authWithHeaders,
				defaults: options?.defaults ?? ({} as Record<string, unknown>),
				imagePlaceholders: options?.imagePlaceholders,
			});
			return bindWithPikiOptions(bound as BoundPikiModel, baseOptions);
		},
		balance: (query?: { period?: string; days?: number; tz?: string }) =>
			Effect.gen(function* () {
				const http = yield* HttpClient.HttpClient;
				const headers = new Headers();
				authWithHeaders(headers);
				const headerRecord: Record<string, string> = {};
				headers.forEach((value, key) => {
					headerRecord[key] = value;
				});
				const params = new URLSearchParams();
				if (query?.period) params.set("period", query.period);
				if (query?.days != null) params.set("days", String(query.days));
				if (query?.tz) params.set("tz", query.tz);
				const qs = params.toString();
				const url = `${endpoint}/balance${qs ? `?${qs}` : ""}`;
				const request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headerRecord));
				const response = yield* http
					.execute(request)
					.pipe(
						Effect.mapError(
							(err: HttpClientError.HttpClientError) => new Error(`Failed to fetch balance: ${err.message}`),
						),
					);
				if (response.status < 200 || response.status >= 300) {
					const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
					return yield* Effect.fail(new Error(`Failed to fetch balance: HTTP ${response.status} — ${body}`));
				}
				const text = yield* response.text.pipe(
					Effect.mapError(
						(err: HttpClientError.HttpClientError) => new Error(`Failed to read balance response: ${err}`),
					),
				);
				try {
					return JSON.parse(text);
				} catch {
					return yield* Effect.fail(new Error(`Failed to parse balance response: ${text.slice(0, 200)}`));
				}
			}),
		webSearch: <TData>(query: string, schema?: unknown) => webSearch<TData>(query, schema),
	};
}

export class PikiClient extends Context.Tag("PikiClient")<PikiClient, unknown>() {}
