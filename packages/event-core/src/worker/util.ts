export function extractForkIdFromEvent(event: {
	forkId?: unknown;
	payload?: unknown;
	[key: string]: unknown;
}): string | null {
	if ("forkId" in event) {
		const forkId = event.forkId;
		if (typeof forkId === "string" || forkId === null) return forkId;
	}
	const payload = event.payload;
	if (payload && typeof payload === "object") {
		const payloadForkId = (payload as { forkId?: unknown }).forkId;
		if (typeof payloadForkId === "string" || payloadForkId === null) return payloadForkId;
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
