/**
 * GAP-1 parity: Google/Vertex `mapStopReason` collapses the safety/recitation/blocklist
 * finish-reason family to a graceful "stop", matching mag's mapFinishReasonToOutcome
 * (magnitude-alpha22.embedded.js:76649) which maps unrecognized reasons to a graceful
 * Completed outcome.
 *
 * No credentials / network. Pure function assertions.
 */
import { FinishReason } from "@google/genai";
import { describe, expect, it } from "vitest";
import { mapStopReason } from "../src/api/google-shared.ts";

const SAFETY_FAMILY: FinishReason[] = [
	FinishReason.BLOCKLIST,
	FinishReason.PROHIBITED_CONTENT,
	FinishReason.SPII,
	FinishReason.SAFETY,
	FinishReason.IMAGE_SAFETY,
	FinishReason.IMAGE_PROHIBITED_CONTENT,
	FinishReason.IMAGE_RECITATION,
	FinishReason.IMAGE_OTHER,
	FinishReason.RECITATION,
	FinishReason.FINISH_REASON_UNSPECIFIED,
	FinishReason.OTHER,
	FinishReason.LANGUAGE,
	FinishReason.MALFORMED_FUNCTION_CALL,
	FinishReason.UNEXPECTED_TOOL_CALL,
	FinishReason.NO_IMAGE,
];

describe("GAP-1: Google stop-reason safety family collapses to graceful stop", () => {
	it("maps every safety/recitation/blocklist reason to graceful stop", () => {
		for (const reason of SAFETY_FAMILY) {
			expect(mapStopReason(reason)).toBe("stop");
		}
	});

	it("keeps STOP -> stop and MAX_TOKENS -> length (regression guards)", () => {
		expect(mapStopReason(FinishReason.STOP)).toBe("stop");
		expect(mapStopReason(FinishReason.MAX_TOKENS)).toBe("length");
	});

	it("guards that Google has no CONTENT_FILTER finish reason (would break parity)", () => {
		// mag's content_filter -> ContentFiltered is a Bedrock concept; Google's enum has no
		// CONTENT_FILTER member. If a future SDK adds one, this fails loudly so the mapper can
		// be revisited instead of silently diverging from mag.
		const members = Object.values(FinishReason);
		expect(members).not.toContain("CONTENT_FILTER");
	});
});
