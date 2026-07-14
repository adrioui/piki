import type { Effect, Schema } from "effect";
import { Data } from "effect";

/** A tool definition as specified in the harness config. */
export interface HarnessToolDefinition<TInput = Record<string, unknown>, TOutput = Record<string, unknown>> {
	name: string;
	description: string;
	inputSchema: Schema.Schema<TInput>;
	outputSchema: Schema.Schema<TOutput>;
}

/** Stream handler for validating/transforming input during streaming. */
export interface HarnessToolStream<TInput = Record<string, unknown>> {
	onInput?: (input: Partial<TInput>) => void;
}

/** Config accepted by defineHarnessTool. */
export interface HarnessToolConfig<
	TInput = Record<string, unknown>,
	TOutput = Record<string, unknown>,
	TError = Record<string, unknown>,
> {
	definition: HarnessToolDefinition<TInput, TOutput>;
	execute: (input: TInput) => Effect.Effect<TOutput, TError>;
	stream?: HarnessToolStream<TInput>;
	emissionSchema?: Schema.Schema<unknown>;
	errorSchema?: Schema.Schema<TError>;
}

/** The frozen tool object returned by defineHarnessTool. */
export interface HarnessTool<
	TInput = Record<string, unknown>,
	TOutput = Record<string, unknown>,
	TError = Record<string, unknown>,
> {
	definition: HarnessToolDefinition<TInput, TOutput>;
	execute: (input: TInput) => Effect.Effect<TOutput, TError>;
	stream: HarnessToolStream<TInput> | undefined;
	emissionSchema: Schema.Schema<unknown> | undefined;
	errorSchema: Schema.Schema<TError> | undefined;
}

/** Error thrown when stream input validation fails. */
export class StreamValidationError extends Data.TaggedError("StreamValidationError")<{
	readonly message: string;
}> {}

/**
 * Define a harness tool from a config object.
 */
export function defineHarnessTool<
	TInput = Record<string, unknown>,
	TOutput = Record<string, unknown>,
	TError = Record<string, unknown>,
>(config: HarnessToolConfig<TInput, TOutput, TError>): HarnessTool<TInput, TOutput, TError> {
	return {
		definition: config.definition,
		execute: config.execute,
		stream: config.stream,
		emissionSchema: config.emissionSchema,
		errorSchema: config.errorSchema,
	};
}
