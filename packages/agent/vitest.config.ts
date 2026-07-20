import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcProvidersDir = fileURLToPath(new URL("../ai/src/providers", import.meta.url));
const agentCoreSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const eventCoreSrcIndex = fileURLToPath(new URL("../event-core/src/index.ts", import.meta.url));
const eventCoreSrcTypes = fileURLToPath(new URL("../event-core/src/types.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@piki\/ai$/, replacement: aiSrcIndex },
			{ find: /^@piki\/ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@piki\/ai\/providers\/(.+)$/, replacement: `${aiSrcProvidersDir}/$1` },
			{ find: /^@piki\/agent-core$/, replacement: agentCoreSrcIndex },
			{ find: /^@piki\/event-core\/types$/, replacement: eventCoreSrcTypes },
			{ find: /^@piki\/event-core$/, replacement: eventCoreSrcIndex },
		],
	},
});
