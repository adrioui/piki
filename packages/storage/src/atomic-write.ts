import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
 * never observe a partial file even on crash. Accepts either a pre-serialized
 * string or a value to be JSON-serialized with validation.
 */
export async function atomicWriteFile(path: string, data: unknown): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp`;
	const content = typeof data === "string" ? data : stringifyValidated(data);
	await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
	await rename(tmp, path);
}
