import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import type { AgentTool } from "@piki/agent-core";
import type { Api, ImageContent, Model, TextContent } from "@piki/ai";
import { Text } from "@piki/tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveReadPathAsyncTool } from "./path-utils.ts";
import { getTextOutput, renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const viewSchema = Type.Object({
	path: Type.String({ description: "Relative path to an image file from cwd. Use $M/ prefix for scratchpad path." }),
});

export type ViewToolInput = Static<typeof viewSchema>;

export interface ViewToolDetails {
	mimeType: string;
	width: number;
	height: number;
	wasResized: boolean;
}

/**
 * Pluggable operations for the view tool.
 * Override these to delegate image reading to remote systems (for example SSH).
 */
export interface ViewOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultViewOperations: ViewOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ViewToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for image reading. Default: local filesystem */
	operations?: ViewOperations;
	/** Scratchpad directory, used to resolve $M/ paths with Magnitude-alpha22 parity. */
	scratchpadPath?: string;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function formatViewCall(args: { path?: string } | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: "." });
	return `${theme.fg("toolTitle", theme.bold("view"))} ${pathDisplay}`;
}

function formatViewResult(
	result: { content: (TextContent | ImageContent)[] },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}
	const output = getTextOutput(result, showImages).trim();
	if (output) {
		return `\n${theme.fg("toolOutput", output)}`;
	}
	return "";
}

export function createViewToolDefinition(
	cwd: string,
	options?: ViewToolOptions,
): ToolDefinition<typeof viewSchema, ViewToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultViewOperations;
	const scratchpadPath = options?.scratchpadPath ?? "";
	return {
		name: "view",
		label: "view",
		description:
			"Read an image file and return it as image output for visual inspection. Supports PNG, JPEG, WebP, GIF, and SVG files.",
		parameters: viewSchema,
		async execute(_toolCallId, { path }: { path: string }, signal?: AbortSignal, _onUpdate?, ctx?) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ViewToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsyncTool(path, cwd, scratchpadPath);
							if (aborted) return;
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							if (!mimeType) {
								throw new Error(`File is not a supported image type (jpg, png, gif, webp): ${path}`);
							}
							if (aborted) return;
							const buffer = await ops.readFile(absolutePath);
							if (aborted) return;

							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							let content: (TextContent | ImageContent)[];
							let details: ViewToolDetails | undefined;

							if (autoResizeImages) {
								const resized = await resizeImage(buffer, mimeType);
								if (!resized) {
									let textNote = `Viewed image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
									details = undefined;
								} else {
									const dimensionNote = formatDimensionNote(resized);
									let textNote = `Viewed image file [${resized.mimeType}]`;
									if (dimensionNote) textNote += `\n${dimensionNote}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: resized.data, mimeType: resized.mimeType },
									];
									details = {
										mimeType: resized.mimeType,
										width: resized.width,
										height: resized.height,
										wasResized: resized.wasResized,
									};
								}
							} else {
								let textNote = `Viewed image file [${mimeType}]`;
								if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
								content = [
									{ type: "text", text: textNote },
									{ type: "image", data: buffer.toString("base64"), mimeType },
								];
								details = {
									mimeType,
									width: 0,
									height: 0,
									wasResized: false,
								};
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatViewCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatViewResult(result, options, theme, context.showImages, context.isError));
			return text;
		},
	};
}

export function createViewTool(cwd: string, options?: ViewToolOptions): AgentTool<typeof viewSchema> {
	return wrapToolDefinition(createViewToolDefinition(cwd, options));
}
