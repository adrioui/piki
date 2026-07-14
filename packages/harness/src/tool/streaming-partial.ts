/** Marker for a streaming partial value that is not yet final. */
export interface StreamingPartial<T = unknown> {
	readonly isFinal: false;
	readonly value: T;
}

/** Apply a chunk delta at a nested path inside a streaming partial tree. */
export function applyFieldChunk<T>(partial: T, path: readonly string[], delta: string): T {
	if (path.length === 0) return partial;

	const result = { ...(partial as Record<string, unknown>) };
	let cursor = result as Record<string, unknown>;

	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i]!;
		cursor[key] = cursor[key] ? { ...(cursor[key] as Record<string, unknown>) } : {};
		cursor = cursor[key] as Record<string, unknown>;
	}

	const leaf = path[path.length - 1]!;
	const existing = cursor[leaf] as StreamingPartial<string> | undefined;

	if (existing && !existing.isFinal) {
		cursor[leaf] = { isFinal: false, value: existing.value + delta };
	} else {
		cursor[leaf] = { isFinal: false, value: delta };
	}

	return result as T;
}

/** Strip StreamingPartial wrappers, returning plain values. */
export function extractStreamingPartialValues<T>(partial: T): T {
	if (partial === null || partial === undefined) return partial;
	if (typeof partial !== "object") return partial;

	if (
		partial !== null &&
		typeof partial === "object" &&
		"isFinal" in partial &&
		"value" in partial &&
		(partial as Record<string, unknown>).isFinal === false
	) {
		return (partial as StreamingPartial<T>).value;
	}

	if (Array.isArray(partial)) {
		return partial.map((item) => extractStreamingPartialValues(item)) as T;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
		result[key] = extractStreamingPartialValues(value);
	}
	return result as T;
}
