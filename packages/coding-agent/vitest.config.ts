import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const eventCoreSrcIndex = fileURLToPath(new URL("../event-core/src/index.ts", import.meta.url));
const eventCoreSrcTypes = fileURLToPath(new URL("../event-core/src/types.ts", import.meta.url));
const skillsSrcIndex = fileURLToPath(new URL("../skills/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 60000,
		fileParallelism: false,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@piki\/ai$/, replacement: aiSrcIndex },
			{ find: /^@piki\/ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@piki\/ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@piki\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@piki\/event-core$/, replacement: eventCoreSrcIndex },
			{ find: /^@piki\/event-core\/types$/, replacement: eventCoreSrcTypes },
			{ find: /^@piki\/skills$/, replacement: skillsSrcIndex },
			{ find: /^@piki\/tui$/, replacement: tuiSrcIndex },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-event-core$/, replacement: eventCoreSrcIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
