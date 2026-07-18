/**
 * Wave-2 provider/streaming parity probes (sci-wave2-providers).
 *
 * Locks the documented live-path contracts that differ from Mag ONLY in intent
 * (S-LV malformed tool-call arg leniency, P0/P0-b graceful finish_reason mapping).
 * These assertions pin piki's CURRENT chosen behavior so a silent regression
 * (e.g. switching to strict-fail, or throwing on unknown finish_reason) is caught.
 *
 * No network, no credentials. Pure-function probes over exported decoder helpers.
 */
import { describe, expect, it } from "vitest";
import { mapStopReason as mapResponsesStopReason } from "../src/api/openai-responses-shared.ts";
import { parseStreamingJson } from "../src/utils/json-parse.ts";

// NOTE: openai-completions.ts `mapStopReason` is internal (not exported) and is
// already covered by packages/ai/test/s7-stream-parity.test.ts via the native codec
// (byte-identical to mag decode7). This probe imports only exported helpers.

describe("W2 S-LV: live-path malformed/incomplete tool-call JSON is best-effort (not hard-fail)", () => {
	it("does not hard-fail on truncated JSON object (stream ended mid-arg)", () => {
		// Mag's decode7 would emit validation_failure -> StreamFailed on this; piki's
		// partial-json fallback returns a best-effort object instead of throwing.
		const parsed = parseStreamingJson<{ path?: string }>('{"path": "/tmp/foo');
		expect(parsed).toBeTypeOf("object");
		expect(parsed).not.toBeNull();
	});

	it("returns {} for structurally invalid JSON with stray braces (unrepairable)", () => {
		// partial-json + repairJson both fail -> piki returns {} (best-effort empty), never throws.
		expect(parseStreamingJson('{path: /tmp/foo, content: "x"}}')).toEqual({});
	});

	it("does not hard-fail on JSON containing raw control characters inside a string", () => {
		// Mag's decode7 would emit validation_failure -> StreamFailed; piki's partial-json
		// fallback returns a best-effort object instead of throwing. Assert non-throwing +
		// best-effort (not a thrown StreamFailed), pinning the lenient contract.
		const parsed = parseStreamingJson<{ content?: string }>('{"content": "line1\nline2\x01raw"}');
		expect(parsed).toBeTypeOf("object");
		expect(parsed).not.toBeNull();
	});

	it("returns {} for empty / whitespace input", () => {
		expect(parseStreamingJson("")).toEqual({});
		expect(parseStreamingJson("   ")).toEqual({});
		expect(parseStreamingJson(undefined)).toEqual({});
	});

	it("repaired partial object yields best-effort parsed args, not {} (when repairable)", () => {
		const parsed = parseStreamingJson<{ path?: string; content?: string }>('{"path": "/tmp/foo"}');
		expect(parsed.path).toBe("/tmp/foo");
	});
});

describe("W2 P0/P0-b: graceful finish_reason mapping (openai-responses live decoder)", () => {
	it("openai-responses mapStopReason: unknown status -> 'stop' (graceful, no throw)", () => {
		expect(mapResponsesStopReason("some_future_status" as never)).toBe("stop");
		expect(mapResponsesStopReason(undefined)).toBe("stop");
	});

	it("openai-responses mapStopReason: content_filter -> 'stop' (responses API has no content_filter status)", () => {
		// Responses API status vocabulary differs from completions; mapStopReason treats
		// unrecognized statuses as graceful stop, matching mag's lenient terminal handling.
		expect(mapResponsesStopReason("content_filter" as never)).toBe("stop");
	});

	it("openai-responses mapStopReason: completed -> 'stop', incomplete -> 'length'", () => {
		expect(mapResponsesStopReason("completed")).toBe("stop");
		expect(mapResponsesStopReason("incomplete")).toBe("length");
	});
});
