/**
 * Human-readable token count formatting.
 *
 * NOTE: This formats *tokens*, not bytes. The existing `formatSize` in
 * `harness/utils/truncate.ts` formats byte sizes (KB/MB) and is unrelated.
 */

/**
 * Format a token count for display.
 *
 * - `< 1000` → plain number string (e.g. `"42"`)
 * - `>= 10_000` → rounded k (e.g. `"12k"`)
 * - otherwise → one-decimal k (e.g. `"1.5k"`)
 */
export function formatSize(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	const k = tokens / 1000;
	return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
}
