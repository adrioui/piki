import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { EpochInterruptCoordinator } from "../src/core/epoch-interrupt-coordinator.ts";

describe("EpochInterruptCoordinator", () => {
	it("marks interrupted epochs stale and starts fresh epochs for new turns", () => {
		const coordinator = new EpochInterruptCoordinator();

		const first = Effect.runSync(coordinator.beginTurn());
		expect(coordinator.isCurrent(first)).toBe(true);

		Effect.runSync(coordinator.interrupt("test"));
		expect(coordinator.isCurrent(first)).toBe(false);
		expect(coordinator.isInterrupted(first)).toBe(true);

		const second = Effect.runSync(coordinator.beginTurn());
		expect(coordinator.isCurrent(second)).toBe(true);
		expect(second.value).toBe(first.value + 1);
	});

	describe("captureToken / isTokenCurrent", () => {
		it("returns a token that is current immediately after capture", () => {
			const coordinator = new EpochInterruptCoordinator();
			Effect.runSync(coordinator.beginTurn());

			const token = coordinator.captureToken();
			expect(coordinator.isTokenCurrent(token)).toBe(true);
		});

		it("returns stale token after interrupt", () => {
			const coordinator = new EpochInterruptCoordinator();
			Effect.runSync(coordinator.beginTurn());

			const token = coordinator.captureToken();
			Effect.runSync(coordinator.interrupt("user abort"));

			expect(coordinator.isTokenCurrent(token)).toBe(false);
		});

		it("returns stale token after epoch advances (new turn)", () => {
			const coordinator = new EpochInterruptCoordinator();
			Effect.runSync(coordinator.beginTurn());

			const token = coordinator.captureToken();

			// Simulate a new turn starting (e.g. from a retry or steering)
			Effect.runSync(coordinator.beginTurn());

			expect(coordinator.isTokenCurrent(token)).toBe(false);
		});

		it("new token from advanced epoch is current", () => {
			const coordinator = new EpochInterruptCoordinator();
			Effect.runSync(coordinator.beginTurn());
			const oldToken = coordinator.captureToken();

			Effect.runSync(coordinator.beginTurn());
			const newToken = coordinator.captureToken();

			expect(coordinator.isTokenCurrent(oldToken)).toBe(false);
			expect(coordinator.isTokenCurrent(newToken)).toBe(true);
		});

		it("token is stale when no turn has started (epoch 0)", () => {
			const coordinator = new EpochInterruptCoordinator();
			const token = coordinator.captureToken();

			// Epoch is 0, token epoch is 0, but no turn has begun
			// isTokenCurrent should still return true (epoch matches, not interrupted)
			expect(coordinator.isTokenCurrent(token)).toBe(true);
		});

		it("multiple tokens from same turn are all current", () => {
			const coordinator = new EpochInterruptCoordinator();
			Effect.runSync(coordinator.beginTurn());

			const token1 = coordinator.captureToken();
			const token2 = coordinator.captureToken();
			const token3 = coordinator.captureToken();

			expect(coordinator.isTokenCurrent(token1)).toBe(true);
			expect(coordinator.isTokenCurrent(token2)).toBe(true);
			expect(coordinator.isTokenCurrent(token3)).toBe(true);
		});

		it("tokens become stale after interrupt even if captured before interrupt", () => {
			const coordinator = new EpochInterruptCoordinator();
			Effect.runSync(coordinator.beginTurn());

			// Capture multiple tokens at different points
			const tokenBefore = coordinator.captureToken();
			// ... some async work happens ...
			const tokenAfter = coordinator.captureToken();

			// Interrupt the turn
			Effect.runSync(coordinator.interrupt("abort"));

			// Both tokens should be stale
			expect(coordinator.isTokenCurrent(tokenBefore)).toBe(false);
			expect(coordinator.isTokenCurrent(tokenAfter)).toBe(false);
		});
	});
});
