/**
 * Bounded JSON measurement.
 *
 * Recursively walks a JSON-serialisable value, counting the escaped
 * character length. Short-circuits once the cap is reached so that
 * deeply-nested or very large values don't blow up.
 */

import { CHARS_PER_TOKEN_UPPER } from "../../constants.ts";
import type { Measurement } from "../budget.ts";
import { charsToTokensUpper } from "../budget.ts";

/**
 * Return the number of escaped characters a single JSON char-code
 * occupies in a serialised string (accounting for escapes like `\"`,
 * `\\`, control chars, and surrogate pairs).
 */
export function jsonEscapedCharLen(code: number): number {
	if (code === 34 || code === 92) return 2; // " or \
	if (code < 32) {
		// common whitespace kept as 2-char escapes
		if (code === 8 || code === 9 || code === 10 || code === 12 || code === 13) return 2;
		return 6; // \uXXXX
	}
	if (code >= 55296 && code <= 57343) return 6; // lone surrogate → \uXXXX
	return 1;
}

/**
 * Measure a JSON-serialisable value up to a token budget cap.
 *
 * Returns a {@link Measurement} whose `size` is the estimated token count
 * (upper-bound conversion) and `exceeded` indicates whether the walk had
 * to stop early or the total char count surpasses the cap.
 */
export function measureBounded(value: unknown, capTokens: number): Measurement {
	const capChars = capTokens * CHARS_PER_TOKEN_UPPER;
	let count = 0;

	function measure(v: unknown): boolean {
		if (count > capChars) return false;

		if (v === null) {
			count += 4; // "null"
			return true;
		}
		if (v === undefined) {
			count += 9; // "undefined" — matches capture
			return true;
		}
		if (typeof v === "boolean") {
			count += v ? 4 : 5; // "true" / "false"
			return true;
		}
		if (typeof v === "number") {
			count += String(v).length;
			return true;
		}
		if (typeof v === "string") {
			count += 2; // opening and closing "
			for (let j = 0; j < v.length; j++) {
				count += jsonEscapedCharLen(v.charCodeAt(j));
				if (count > capChars) return false;
			}
			return count <= capChars;
		}
		if (Array.isArray(v)) {
			count += 2; // [ ]
			for (let i = 0; i < v.length; i++) {
				if (i > 0) count += 2; // ", "
				if (!measure(v[i])) return false;
			}
			return count <= capChars;
		}
		if (typeof v === "object") {
			count += 2; // { }
			const entries = Object.entries(v as Record<string, unknown>);
			for (let i = 0; i < entries.length; i++) {
				if (i > 0) count += 2; // ", "
				count += entries[i][0].length + 2; // "key": (with quotes)
				if (!measure(entries[i][1])) return false;
			}
			return count <= capChars;
		}
		return true;
	}

	const completed = measure(value);

	return {
		size: charsToTokensUpper(Math.min(count, capChars)),
		exceeded: !completed || count > capChars,
	};
}
