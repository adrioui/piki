import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { KILO_BASE_URL, KILO_MODELS } from "./kilo.models.ts";

/**
 * Keyless auth for the Kilo free tier. Kilo's gateway serves free models
 * without an API key (paid access is via optional device OAuth in pi-free);
 * the request goes out with no Authorization header. Resolving to an empty
 * auth object reports the provider as configured so `Models.getAuth()` does
 * not treat it as unconfigured.
 */
function kiloAuth(): ApiKeyAuth {
	return {
		name: "Kilo (free, no key required)",
		resolve: async () => ({ auth: {} }),
	};
}

export function kiloProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "kilo",
		name: "Kilo",
		baseUrl: KILO_BASE_URL,
		headers: {
			"X-KILOCODE-EDITORNAME": "Pi",
		},
		auth: { apiKey: kiloAuth() },
		models: Object.values(KILO_MODELS),
		api: openAICompletionsApi(),
	});
}
