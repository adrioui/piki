import { HttpClient, type HttpClientError, HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";

/**
 * Model catalog backed by the server `/models` endpoint, with a TTL cache.
 */
export function createModelCatalog(config: { endpoint: string; auth: (headers: Headers) => void; ttlMs?: number }) {
	const { endpoint, auth, ttlMs = 5 * 60 * 1000 } = config;
	let cache: unknown[] | null = null;
	let fetchedAt = 0;

	const fetchModels = Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const headers = new Headers();
		auth(headers);
		const headerRecord: Record<string, string> = {};
		headers.forEach((value, key) => {
			headerRecord[key] = value;
		});
		const request = HttpClientRequest.get(`${endpoint}/models`).pipe(HttpClientRequest.setHeaders(headerRecord));
		const response = yield* client
			.execute(request)
			.pipe(
				Effect.mapError(
					(err: HttpClientError.HttpClientError) => new Error(`Failed to fetch models: ${err.message}`),
				),
			);
		if (response.status < 200 || response.status >= 300) {
			const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
			return yield* Effect.fail(new Error(`Failed to fetch models: HTTP ${response.status} — ${body}`));
		}
		const text = yield* response.text.pipe(
			Effect.mapError((err: HttpClientError.HttpClientError) => new Error(`Failed to read models response: ${err}`)),
		);
		let parsed: { data?: unknown };
		try {
			parsed = JSON.parse(text);
		} catch {
			return yield* Effect.fail(new Error(`Failed to parse models response: ${text.slice(0, 200)}`));
		}
		if (!parsed.data || !Array.isArray(parsed.data)) {
			return yield* Effect.fail(new Error(`Invalid models response: missing "data" array`));
		}
		return parsed.data;
	});

	const list = Effect.gen(function* () {
		if (cache && Date.now() - fetchedAt < ttlMs) {
			return cache;
		}
		const models = yield* fetchModels;
		cache = models;
		fetchedAt = Date.now();
		return models;
	});

	const get = (id: string) =>
		Effect.gen(function* () {
			const models = yield* list;
			const model = (models as Array<{ id: string }>).find((m) => m.id === id);
			if (!model) {
				return yield* Effect.fail(new Error(`Model not found: ${id}`));
			}
			return model;
		});

	const getByRole = (role: string) =>
		Effect.gen(function* () {
			const models = yield* list;
			const model = (models as Array<{ roles: string[] }>).find((m) => m.roles.includes(role));
			if (!model) {
				return yield* Effect.fail(new Error(`No model found for role: ${role}`));
			}
			return model;
		});

	const refresh = Effect.gen(function* () {
		const models = yield* fetchModels;
		cache = models;
		fetchedAt = Date.now();
		return models;
	});

	return { list, get, getByRole, refresh };
}
