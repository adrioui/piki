import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Attach a newline-delimited (JSONL) line reader to a Readable stream.
 *
 * Buffers partial chunks across `data` events, correctly handling multi-byte
 * UTF-8 boundaries via StringDecoder, and invokes `onLine` once per complete
 * line (split on `\n`, with a trailing `\r` stripped for CRLF tolerance).
 *
 * Only a `data` listener is attached; EOF handling is left to the caller's own
 * `end` listener so shutdown semantics (e.g. `rpc-mode.ts`'s `onInputEnd`) remain
 * authoritative.
 *
 * @returns a disposer that removes the `data` listener.
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	stream.on("data", onData);

	return () => {
		stream.off("data", onData);
	};
}
