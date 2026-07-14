export { createModelCatalog } from "./catalog.ts";
export { createPikiClient, type PikiClient, WebSearchError } from "./client.ts";
export {
	CLIENT_PLATFORM,
	CLIENT_SHELL,
	detectShell,
	HEADER_PLATFORM,
	HEADER_SESSION_ID,
	HEADER_SHELL,
	HEADER_USE_DEDICATED,
	normalizePlatform,
} from "./client-headers.ts";
export { isEnvFlagOn } from "./env.ts";
export {
	classifyPikiError,
	classifyPikiRejectedResponse,
	ERROR_CODES,
	ERROR_TYPES,
	TRACE_HEADER2,
} from "./errors.ts";
export {
	bindWithPikiOptions,
	createPikiCompatibleSpec,
	createRoleSpec,
	pikiOptions,
	toModelProfile,
} from "./models.ts";
