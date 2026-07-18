/**
 * GAP-1 (streaming) — parity divergence lock-in tests.
 *
 * These do NOT modify source. They document the *actual* piki streaming
 * behavior against the mag-alpha22 bundle and assert piki keeps behaving that
 * way, so future refactors cannot silently regress parity.
 *
 * Finding (see scratchpad/reports/sci-wave-final-stream.md):
 *   - piki's OpenAI-family decoders finalize tool-call arguments with the
 *     lenient `parseStreamingJson` (partial-json + json repair). It NEVER
 *     raises a hard validation failure on malformed/truncated args.
 *   - mag's `nativeChatCompletionsCodec` (`decode7`) finalizes tool-call args
 *     with the schema-validating Effect `createStreamingFieldParser`; a
 *     malformed/incomplete arg yields `validation_failure` →
 *     `ToolInputValidationFailure` and the turn aborts.
 *   => DIVERGENCE: piki is MORE lenient than mag. piki tolerates streams mag
 *      would reject. (Not a source gap to "fix" by making piki stricter; piki's
 *      leniency is intentional and arguably better.)
 *   - piki additionally has `recoverTextToolCall` (packages/agent/src/agent-loop.ts,
 *     internal, not exported from the package index) that rebuilds a structured
 *     tool call from a bare-text JSON assistant message. mag has NO text→tool
 *     recovery anywhere. => piki diverges (more resilient). Documented via
 *     source reference in the report; not runtime-asserted here because the
 *     function is internal-only.
 */

import { parseStreamingJson } from "@piki/ai";
import { describe, expect, it } from "vitest";

describe("GAP-1 — tool-call arg parsing leniency vs mag", () => {
	it("never throws on truncated/malformed JSON fragments (mag would hard-fail)", () => {
		// A truncated object that mag's schema-validating parser marks invalid.
		expect(() => parseStreamingJson('{"path": "/tmp/foo')).not.toThrow();
		const parsed = parseStreamingJson('{"path": "/tmp/foo');
		// partial-json recovers the best-effort object.
		expect(parsed).toMatchObject({ path: "/tmp/foo" });
	});

	it("recovers broken escapes instead of failing", () => {
		const parsed = parseStreamingJson('{"path": "C:\\Users\\name"}');
		expect(parsed).toMatchObject({ path: expect.any(String) });
	});

	it("returns {} for empty/undefined input rather than rejecting", () => {
		expect(parseStreamingJson(undefined)).toEqual({});
		expect(parseStreamingJson("")).toEqual({});
	});
});
