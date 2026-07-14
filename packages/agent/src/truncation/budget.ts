/**
 * Token budget allocation.
 */

import { CHARS_PER_TOKEN_UPPER } from "../constants.ts";

/**
 * A measurement entry used by {@link allocateBudget}.
 */
export interface Measurement {
	readonly size: number;
	readonly exceeded: boolean;
}

/**
 * Convert a character count to an upper-bound token estimate.
 */
export function charsToTokensUpper(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN_UPPER);
}

/**
 * Distribute a token budget across measured items using smallest-first
 * allocation. Items that haven't exceeded their measured size are given
 * exactly their measured size if it fits; otherwise each item receives an
 * equal floor share of the remaining budget.
 */
export function allocateBudget(measurements: Measurement[], budgetTokens: number): number[] {
	const n = measurements.length;
	if (n === 0) return [];

	const allocations = new Array<number>(n).fill(0);
	const indices = measurements.map((_, i) => i);
	indices.sort((a, b) => measurements[a].size - measurements[b].size);

	let remaining = budgetTokens;
	let count = n;

	for (const i of indices) {
		const share = remaining / count;
		const m = measurements[i];
		if (!m.exceeded && m.size <= share) {
			allocations[i] = m.size;
			remaining -= m.size;
		} else {
			allocations[i] = Math.floor(share);
			remaining -= Math.floor(share);
		}
		count--;
	}

	return allocations;
}
