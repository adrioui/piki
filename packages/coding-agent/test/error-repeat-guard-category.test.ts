import { describe, expect, test } from "vitest";
import { ErrorRepeatGuard } from "../src/core/error-repeat-guard.ts";

describe("ErrorRepeatGuard category awareness", () => {
	test("category is appended to the fingerprint", () => {
		const guard = new ErrorRepeatGuard({ threshold: 3 });

		const permission = guard.recordError("read", { path: "x" }, "Permission denied", "permission");
		const fs = guard.recordError("read", { path: "x" }, "Permission denied", "filesystem");

		// Same tool + args + error text but different category => distinct fingerprints.
		expect(permission.fingerprint).not.toBe(fs.fingerprint);
		expect(permission.repeatCount).toBe(1);
		expect(fs.repeatCount).toBe(1);
	});

	test("omitting category keeps legacy fingerprint behavior", () => {
		const guard = new ErrorRepeatGuard({ threshold: 2 });
		const a = guard.recordError("bash", { command: "npm test" }, "Error: failed");
		const b = guard.recordError("bash", { command: "npm test" }, "Error: failed");
		expect(a.fingerprint).toBe(b.fingerprint);
		expect(b.repeatCount).toBe(2);
		expect(b.shouldStop).toBe(true);
	});

	test("retryable network vs permanent permission are treated independently", () => {
		const guard = new ErrorRepeatGuard({ threshold: 3 });

		// Network error retries 3 times -> shouldStop true.
		for (let i = 1; i <= 3; i++) {
			expect(guard.recordError("web_fetch", {}, "fetch failed: ETIMEDOUT", "network").shouldStop).toBe(i >= 3);
		}
		// A separate permission error on the same tool/args still starts fresh.
		const perm = guard.recordError("web_fetch", {}, "fetch failed: ETIMEDOUT", "permission");
		expect(perm.repeatCount).toBe(1);
		expect(perm.shouldStop).toBe(false);
	});
});
