import { describe, expect, it } from "vitest";
import { buildWorkerContext } from "../src/core/worker-context-builder.ts";

describe("buildWorkerContext", () => {
	it("keeps the first transcript entry and recent entries within budget", () => {
		const context = buildWorkerContext({
			projectContext: "cwd: /repo",
			transcript: [
				"USER:\noriginal request",
				"ASSISTANT:\nold middle details".repeat(20),
				"USER:\nlatest constraint",
			].join("\n\n"),
			maxTranscriptChars: 80,
		});

		expect(context).toContain("USER:\noriginal request");
		expect(context).toContain("USER:\nlatest constraint");
		expect(context).toContain("[Earlier content truncated]");
		expect(context).not.toContain("old middle detailsold middle detailsold middle detailsold middle details");
	});
});
