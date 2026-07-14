export function extractForkIdFromEvent(event: { forkId?: unknown; [key: string]: unknown }): string | null {
	if ("forkId" in event) {
		const forkId = event.forkId;
		if (typeof forkId === "string" || forkId === null) return forkId;
	}
	return null;
}

export function extractForkIdFromSignal(value: unknown): string | null {
	if (value && typeof value === "object" && "forkId" in value) {
		const forkId = (value as { forkId: unknown }).forkId;
		if (typeof forkId === "string" || forkId === null) return forkId;
	}
	return null;
}
