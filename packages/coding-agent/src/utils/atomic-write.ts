import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * Serialize a value to JSON and validate it before returning the string.
 *
 * Throws on circular or otherwise non-serializable input. Callers should
 * produce the serialized string via this helper so that a serialization
 * failure is surfaced before any file write begins.
 */
export function stringifyValidated(value: unknown): string {
	const serialized = JSON.stringify(value, null, 2);
	JSON.parse(serialized); // throws on circular/non-serializable input
	return serialized;
}

/**
 * Write `data` to `path` atomically by writing a temp file then renaming it
 * onto the target. `rename` within a single filesystem is atomic, so readers
 * never observe a partial file even on crash. The temp fd is fsync'd before
 * rename to reduce the window in which the rename target is missing.
 */
export function atomicWriteSync(path: string, data: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp`;
	const fd = openSync(tmp, "w");
	try {
		writeFileSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}
