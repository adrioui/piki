import { Effect } from "effect";

export interface TurnEpoch {
	readonly value: number;
}

/**
 * A lightweight token captured at a point in time that records the epoch value.
 * Used by async flows (streaming, tool execution, retries) to detect whether
 * the turn was interrupted before their results should be persisted or emitted.
 */
export interface EpochToken {
	/** The epoch value when this token was captured. */
	readonly epoch: number;
}

export class EpochInterruptCoordinator {
	private epoch = 0;
	private interruptedEpochs = new Set<number>();

	beginTurn(): Effect.Effect<TurnEpoch> {
		return Effect.sync(() => {
			this.epoch++;
			return { value: this.epoch };
		});
	}

	interrupt(_reason?: string): Effect.Effect<TurnEpoch> {
		return Effect.sync(() => {
			this.interruptedEpochs.add(this.epoch);
			return { value: this.epoch };
		});
	}

	current(): TurnEpoch {
		return { value: this.epoch };
	}

	/**
	 * Capture the current epoch as a lightweight token.
	 * Call this before starting an async flow (streaming, tool execution, retry)
	 * and check with {@link isTokenCurrent} before persisting results.
	 */
	captureToken(): EpochToken {
		return { epoch: this.epoch };
	}

	/**
	 * Check whether a captured token is still current (same epoch, not interrupted).
	 * Returns true if the token's epoch matches the current epoch and has not been
	 * marked as interrupted. Returns false if the epoch advanced (new turn started)
	 * or the token's epoch was interrupted (user aborted).
	 */
	isTokenCurrent(token: EpochToken): boolean {
		return token.epoch === this.epoch && !this.interruptedEpochs.has(token.epoch);
	}

	isCurrent(epoch: TurnEpoch): boolean {
		return epoch.value === this.epoch && !this.interruptedEpochs.has(epoch.value);
	}

	isInterrupted(epoch: TurnEpoch): boolean {
		return this.interruptedEpochs.has(epoch.value);
	}
}
