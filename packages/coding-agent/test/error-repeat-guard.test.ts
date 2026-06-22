import { describe, expect, test } from "vitest";
import { ErrorRepeatGuard } from "../src/core/error-repeat-guard.ts";

describe("ErrorRepeatGuard", () => {
	test("trips after the same tool args and normalized error repeat to threshold", () => {
		const guard = new ErrorRepeatGuard({ threshold: 3 });
		const args = { command: "npm test", timestamp: "2026-06-21T00:00:00Z" };

		expect(guard.recordError("bash", args, "Error: failed\nextra details").shouldStop).toBe(false);
		expect(
			guard.recordError("bash", { timestamp: "later", command: "npm test" }, "Error: failed\nother details")
				.shouldStop,
		).toBe(false);
		const third = guard.recordError("bash", { command: "npm test" }, "Error: failed");

		expect(third.repeatCount).toBe(3);
		expect(third.shouldStop).toBe(true);
	});

	test("does not trip for changed args", () => {
		const guard = new ErrorRepeatGuard({ threshold: 2 });

		expect(guard.recordError("bash", { command: "npm test" }, "Error: failed").shouldStop).toBe(false);
		expect(guard.recordError("bash", { command: "npm test -- --runInBand" }, "Error: failed").shouldStop).toBe(false);
	});

	test("normalizes paths and timestamps in error text", () => {
		const guard = new ErrorRepeatGuard({ threshold: 2 });

		expect(
			guard.recordError(
				"read",
				{ file_path: "/tmp/project/src/a.ts" },
				"2026-06-21T00:00:00Z /tmp/project/src/a.ts missing",
			).shouldStop,
		).toBe(false);
		expect(
			guard.recordError(
				"read",
				{ file_path: "/tmp/project/src/a.ts" },
				"2026-06-21T00:01:00Z /home/me/src/a.ts missing",
			).shouldStop,
		).toBe(true);
	});
});
