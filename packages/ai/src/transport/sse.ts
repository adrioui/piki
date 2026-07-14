/**
 * SSE stream parsing.
 */

import { Stream } from "effect";

function dataPayload(line: string): string | null {
	if (!line.startsWith("data:")) return null;
	const remainder = line.slice("data:".length);
	return remainder.startsWith(" ") ? remainder.slice(1) : remainder;
}

export function sseStream<TPayload, TDecoded, E, E2>(
	byteStream: Stream.Stream<Uint8Array, E>,
	decodePayload: (raw: string) => Stream.Stream<TDecoded, E2, TPayload>,
	doneSignal = "[DONE]",
) {
	return byteStream.pipe(
		Stream.decodeText("utf-8"),
		Stream.splitLines,
		Stream.filter((line) => line.length > 0 && !line.startsWith(":")),
		Stream.map(dataPayload),
		Stream.filter((payload) => payload !== null),
		Stream.takeUntil((payload) => payload === doneSignal),
		Stream.filter((payload) => payload !== doneSignal),
		Stream.flatMap(decodePayload),
	);
}
