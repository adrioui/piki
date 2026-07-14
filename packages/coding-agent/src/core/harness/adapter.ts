import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@piki/agent-core";
import type { ImageContent, TextContent } from "@piki/ai";
import { Effect } from "effect";
import type { TSchema } from "typebox";
import type { HarnessTool } from "./types.ts";

export type HarnessOutputFormatter<TOutput> = (output: TOutput) => string;
export type HarnessContentBlockFormatter<TInput, TOutput> = (
	output: TOutput,
	input: TInput,
) => (TextContent | ImageContent)[];

export interface HarnessAgentToolAdapterOptions<TInput, TOutput, TParameters extends TSchema> {
	parameters: TParameters;
	label?: string;
	formatOutput?: HarnessOutputFormatter<TOutput>;
	toContentBlocks?: HarnessContentBlockFormatter<TInput, TOutput>;
	onEmission?: (output: TOutput, onUpdate: AgentToolUpdateCallback<TOutput> | undefined, input: TInput) => void;
	mapInput?: (args: unknown) => TInput;
}

export interface HarnessBackedAgentTool<TInput, TError, TParameters extends TSchema, TDetails>
	extends AgentTool<TParameters, TDetails> {
	stream: HarnessTool<TInput, TDetails, TError>["stream"];
	emissionSchema: HarnessTool<TInput, TDetails, TError>["emissionSchema"];
	errorSchema: HarnessTool<TInput, TDetails, TError>["errorSchema"];
}

export function harnessToolToAgentTool<TInput, TOutput, TError, TParameters extends TSchema>(
	tool: HarnessTool<TInput, TOutput, TError>,
	options: HarnessAgentToolAdapterOptions<TInput, TOutput, TParameters>,
): HarnessBackedAgentTool<TInput, TError, TParameters, TOutput> {
	return {
		name: tool.definition.name,
		label: options.label ?? tool.definition.name,
		description: tool.definition.description,
		parameters: options.parameters,
		stream: tool.stream,
		emissionSchema: tool.emissionSchema,
		errorSchema: tool.errorSchema,
		execute: async (_toolCallId, params, signal, onUpdate): Promise<AgentToolResult<TOutput>> => {
			if (signal?.aborted) throw new Error("Operation aborted");
			const input = options.mapInput ? options.mapInput(params) : (params as TInput);
			const output = await Effect.runPromise(tool.execute(input));
			if (signal?.aborted) throw new Error("Operation aborted");
			options.onEmission?.(output, onUpdate, input);
			return {
				content: options.toContentBlocks?.(output, input) ?? [
					{
						type: "text",
						text: options.formatOutput ? options.formatOutput(output) : formatHarnessOutput(output),
					},
				],
				details: output,
			};
		},
	};
}

function formatHarnessOutput(output: unknown): string {
	if (typeof output === "string") return output;
	if (output === undefined) return "Done.";
	return JSON.stringify(output, null, 2);
}
