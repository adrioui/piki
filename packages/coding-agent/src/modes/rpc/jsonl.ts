// Stub: jsonl.ts was removed upstream (commit fb43617d7 "remove deprecated modes").
// These functions are referenced by dead-code rpc-client/rpc-mode which are not
// wired into any mode. Kept as stubs to avoid removing potentially useful code.

export function attachJsonlLineReader(_stream: unknown, _callback: (line: string) => void): () => void {
	// stub — RPC mode is not wired into the application
	return () => {};
}

export function serializeJsonLine(data: unknown): string {
	return JSON.stringify(data);
}
