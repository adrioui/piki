import { Data } from "effect";

/** Error thrown when stream input validation fails. */
export class StreamValidationError extends Data.TaggedError("StreamValidationError")<{
	readonly message: string;
}> {}
