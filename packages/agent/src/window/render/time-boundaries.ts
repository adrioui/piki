/**
 * Window render time boundaries.
 *
 * Provides timezone-aware timestamp formatting helpers and a stateful emitter
 * that inserts `--- HH:mm:ss ---` (or `--- YYYY-MM-DD HH:mm:ss ---`) boundary
 * markers into a timeline as the clock rolls over minutes / days.
 *
 * These are pure, synchronous helpers: the formatting
 * functions take a timestamp and optional IANA timezone, and the emitter is a
 * closure holding the last-emitted keys. They are consumed synchronously by
 * `windowToPrompt` / `renderTimeline` in full.ts.
 */

/** Format a timestamp as `HH:mm:ss` (24h) in the given timezone. */
export function formatTime(timestamp: number, timezone?: string): string {
	const d = new Date(timestamp);
	return new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		timeZone: timezone ?? undefined,
	}).format(d);
}

/** Format a timestamp as `YYYY-MM-DD HH:mm:ss` (24h) in the given timezone. */
export function formatDayTime(timestamp: number, timezone?: string): string {
	const d = new Date(timestamp);
	const date = new Intl.DateTimeFormat("sv-SE", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		timeZone: timezone ?? undefined,
	}).format(d);
	return `${date} ${formatTime(timestamp, timezone)}`;
}

/** Calendar-day key (`YYYY-MM-DD`) for the timestamp in the given timezone. */
function dateKey(timestamp: number, timezone?: string): string {
	const d = new Date(timestamp);
	return new Intl.DateTimeFormat("sv-SE", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		timeZone: timezone ?? undefined,
	}).format(d);
}

/** Minute-level key (`YYYY-MM-DD HH:mm`) for the timestamp in the given timezone. */
function minuteKey(timestamp: number, timezone?: string): string {
	const d = new Date(timestamp);
	return new Intl.DateTimeFormat("sv-SE", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZone: timezone ?? undefined,
	}).format(d);
}

/** A boundary marker emitted by `createTimeBoundaryEmitter`. */
export interface TimeBoundaryEmitter {
	/** Returns the next boundary string, or `null` if none is needed yet. */
	next(timestamp: number): string | null;
}

/**
 * Create a stateful emitter that, given successive timeline timestamps,
 * returns a `--- <time> ---` marker whenever the minute rolls over, and
 * includes the full date when the calendar day changes.
 */
export function createTimeBoundaryEmitter(timezone?: string): TimeBoundaryEmitter {
	let lastTimeBoundaryMinuteKey: string | null = null;
	let lastTimeBoundaryDateKey: string | null = null;
	return {
		next(timestamp: number): string | null {
			const currentMinute = minuteKey(timestamp, timezone);
			if (currentMinute === lastTimeBoundaryMinuteKey) return null;
			const currentDate = dateKey(timestamp, timezone);
			const showDate = lastTimeBoundaryMinuteKey == null || currentDate !== lastTimeBoundaryDateKey;
			lastTimeBoundaryMinuteKey = currentMinute;
			lastTimeBoundaryDateKey = currentDate;
			return `--- ${showDate ? formatDayTime(timestamp, timezone) : formatTime(timestamp, timezone)} ---`;
		},
	};
}
