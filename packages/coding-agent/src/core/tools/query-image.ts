/**
 * query_image tool: Query a vision model about an image.
 * Sends an image to an auxiliary vision model and returns the textual response.
 */

import { readFile as fsReadFile } from "node:fs/promises";
import type { AgentTool } from "@piki/agent-core";
import { type Static, Type } from "typebox";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const queryImageSchema = Type.Object({
	path: Type.String({ description: "Relative path to an image file from cwd. Use $M/ prefix for scratchpad path." }),
	query: Type.Optional(
		Type.String({
			description:
				"Question or instruction about what to look for in the image. Defaults to a general description request.",
		}),
	),
});

export type QueryImageInput = Static<typeof queryImageSchema>;

export interface QueryImageToolOptions {
	/**
	 * Resolve a vision-capable model to query images.
	 * Called each time query_image is invoked.
	 * Returns a function that takes (imageBase64, mimeType, query) and returns the model's response.
	 */
	queryVisionModel?: (imageBase64: string, mimeType: string, query: string) => Promise<string>;
}

const DEFAULT_QUERY = "Describe this image in detail.";

export function createQueryImageToolDefinition(
	cwd: string,
	options: QueryImageToolOptions = {},
): ToolDefinition<typeof queryImageSchema> {
	return {
		name: "query_image",
		label: "Query Image",
		description:
			"Query an image file by sending it to an image utility model along with an optional question. Use this to inspect images when the active model does not support direct vision. Supports PNG, JPEG, WebP, and GIF files. When no query is provided, a detailed description of the image is returned.",
		parameters: queryImageSchema,
		async execute(
			_toolCallId,
			{ path, query }: { path: string; query?: string },
			_signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const absolutePath = await resolveReadPathAsync(path, cwd);

			let buffer: Buffer;
			try {
				buffer = await fsReadFile(absolutePath);
			} catch {
				throw new Error(`Cannot read file: ${path}`);
			}

			const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
			if (!mimeType) {
				throw new Error(`File is not a supported image: ${path}`);
			}

			const base64 = buffer.toString("base64");
			const effectiveQuery = query || DEFAULT_QUERY;
			if (!options.queryVisionModel) {
				throw new Error("query_image tool is not connected to a vision model");
			}
			const response = await options.queryVisionModel(base64, mimeType, effectiveQuery);

			return {
				content: [{ type: "text", text: response }],
				details: undefined,
			};
		},
	};
}

export function createQueryImageTool(
	cwd: string,
	options: QueryImageToolOptions = {},
): AgentTool<typeof queryImageSchema> {
	return wrapToolDefinition(createQueryImageToolDefinition(cwd, options));
}
