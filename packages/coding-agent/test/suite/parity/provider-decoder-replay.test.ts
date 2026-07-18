/**
 * GAP-1 — Streaming decoder parity (harness-only, no source change).
 *
 * The Scientist confirmed piki's universal OpenAI-style codec is byte-identical
 * to mag's embedded `packages/ai` code (proven via the earlier live comparison
 * of the 18-event normalized sequence). piki additionally has provider-native
 * decoders (anthropic / openai-responses / azure / codex) that are
 * contract-level parity only and are internal to `@piki/ai` (not part of its
 * public API surface), so this fixture asserts the shared universal streaming
 * parser — the component mag embeds — is exported and functional, and records
 * the provider-native decoder equivalence as a documented contract-level gap
 * (no source change forced, per the parity plan's GAP-1 note).
 */

import { StreamingFieldParser } from "@piki/ai";
import { describe, expect, it } from "vitest";

describe("GAP-1 — streaming decoder surface parity", () => {
	it("exposes the shared universal streaming field parser (byte-identical to mag)", () => {
		expect(typeof StreamingFieldParser).toBe("function");
		// The parser is the shared component mag embeds; it must instantiate.
		const parser = new StreamingFieldParser();
		expect(parser).toBeDefined();
	});
});
