import type { StreamFn } from "@piki/agent-core";
import { fauxAssistantMessage } from "@piki/ai";
import { describe, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

describe("dbg", () => {
	it("abort path detail", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const internals = harness.session as any;
		const origEmit = internals._emit.bind(internals);
		internals._emit = (e: any) => {
			if (e.type?.startsWith("compaction"))
				console.log("DBG_EMIT", e.type, "aborted=", e.aborted, "err=", e.errorMessage?.slice(0, 25));
			return origEmit(e);
		};
		(harness.session.agent as { streamFn: StreamFn }).streamFn = ((_m: any, _c: any, options: any) =>
			new Promise<never>((_r, reject) => {
				options?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
			})) as StreamFn;
		const cp = internals._runAutoCompaction("threshold", false);
		setTimeout(() => harness.session.abortCompaction(), 0);
		await cp;
		harness.cleanup();
	});
});
