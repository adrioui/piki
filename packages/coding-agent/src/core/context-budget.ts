/**
 * Model-proportional tool-output budgets.
 *
 * Tool-output truncation previously used fixed caps (50KB / 2000 lines for file
 * reads, 100KB for activity-formatted results) regardless of the active model's
 * context window. That meant a tiny 8k-context model and a 1M-context model
 * shared an identical tool-output cap, which is both too generous for small
 * windows (wasting scarce context) and too stingy for large ones.
 *
 * These helpers scale the cap with the model's `contextWindow`, bounded by a
 * floor (preserves historical behavior for small models) and a ceiling (bounds
 * the cap for large models).
 */

/** Calibration window: caps at this size reproduce the historical defaults. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

// Average rendered chars per content line, used to derive a line cap from the
// same proportional scheme as the byte cap.
const AVG_CHARS_PER_LINE = 80;

// Byte cap: floor = historical read default, ceiling = large-window allowance.
// Calibrated so a ~200k-context model yields ~100KB (the historical
// activity-formatter cap), the midpoint of floor/ceiling.
const TOOL_OUTPUT_BYTES_FRACTION = 0.5; // 200k -> ~100KB
const MIN_TOOL_OUTPUT_BYTES = 50 * 1024; // 50KB
const MAX_TOOL_OUTPUT_BYTES_CAP = 200 * 1024; // 200KB

// Line cap: floor = historical read default, ceiling = large-window allowance.
// Calibrated so a ~200k-context model yields ~2000 lines (the historical read
// default).
const TOOL_OUTPUT_LINES_FRACTION = 0.8; // 200k -> ~2000 lines (at 80 chars/line)
const MIN_TOOL_OUTPUT_LINES = 2000;
const MAX_TOOL_OUTPUT_LINES_CAP = 8000;

// Parity note (S7 P6): mag's `read` tool uses a FIXED `maxLines = limit ?? 2000`
// regardless of the active model's context window (magnitude-alpha22 embedded.js,
// readTool execute). piki instead scales the read cap with the context window via
// `proportionalToolOutputLines`, floored at 2000 (so it matches mag exactly at and
// below ~200k context) and ceilinged at 8000 for very large windows. This is an
// intentional piki SUPERSET, not a parity defect: mag's fixed 2000 is a legacy
// constant, and forcing a hard 2000 cap would discard legitimate file content for
// large-context models. Do NOT lower MAX_TOOL_OUTPUT_LINES_CAP to 2000 to "match"
// mag; the floor already guarantees mag-equivalent behavior at the common case.

/**
 * Proportional byte cap for tool output, derived from the model context window.
 *
 * - Models at or below the floor window are clamped to {@link MIN_TOOL_OUTPUT_BYTES}.
 * - Models at or above the ceiling window are clamped to {@link MAX_TOOL_OUTPUT_BYTES_CAP}.
 * - A ~200k-context model yields ~100KB, matching the historical default.
 */
export function proportionalToolOutputBytes(contextWindow: number): number {
	const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
	const target = Math.floor(window * TOOL_OUTPUT_BYTES_FRACTION);
	return Math.min(MAX_TOOL_OUTPUT_BYTES_CAP, Math.max(MIN_TOOL_OUTPUT_BYTES, target));
}

/**
 * Proportional line cap for tool output, derived from the model context window.
 *
 * Same floor/ceiling semantics as {@link proportionalToolOutputBytes}, calibrated
 * so a ~200k-context model yields ~2000 lines, matching the historical default.
 */
export function proportionalToolOutputLines(contextWindow: number): number {
	const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
	const target = Math.floor((window * TOOL_OUTPUT_LINES_FRACTION) / AVG_CHARS_PER_LINE);
	return Math.min(MAX_TOOL_OUTPUT_LINES_CAP, Math.max(MIN_TOOL_OUTPUT_LINES, target));
}
