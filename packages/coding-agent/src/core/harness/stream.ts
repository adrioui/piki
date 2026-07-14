import { StreamValidationError } from "./stream-validation.ts";
import type { HarnessToolStream } from "./types.ts";

export function validateStreamInput<TInput>(
	stream: HarnessToolStream<TInput> | undefined,
	input: Partial<TInput>,
): void {
	try {
		stream?.onInput?.(input);
	} catch (error) {
		if (error instanceof StreamValidationError) throw error;
		throw new StreamValidationError({ message: error instanceof Error ? error.message : String(error) });
	}
}
