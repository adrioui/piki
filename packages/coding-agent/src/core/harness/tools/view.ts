import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { AgentTool } from "@piki/agent-core";
import { expandScratchpadPath } from "@piki/scratchpad";
import { Effect, Schema } from "effect";
import { Type } from "typebox";
import { harnessToolToAgentTool } from "../adapter.ts";
import { StreamValidationError } from "../stream-validation.ts";
import { ToolErrorSchema } from "../tool-error.ts";
import { type ToolImage, ToolImageSchema } from "../tool-image.ts";
import type { HarnessTool } from "../types.ts";
import { defineHarnessTool } from "../types.ts";

// ---------------------------------------------------------------------------
// Input schema (Effect Schema)
// ---------------------------------------------------------------------------

export const ViewInputSchema = Schema.Struct({
	path: Schema.String.pipe(
		Schema.annotations({
			description: "Relative path to an image file from cwd. Use $M/ prefix for scratchpad path.",
		}),
	),
});

export type ViewInput = Schema.Schema.Type<typeof ViewInputSchema>;

// ---------------------------------------------------------------------------
// Output schema — ToolImage (from tool-image.ts)
// ---------------------------------------------------------------------------

export const ViewOutputSchema = ToolImageSchema;

// ---------------------------------------------------------------------------
// Error schema — FsError
// ---------------------------------------------------------------------------

export const FsErrorSchema = ToolErrorSchema("FsError", {});

export type FsError = Schema.Schema.Type<typeof FsErrorSchema>;

/** Construct an FsError value. */
function fsError(message: string): FsError {
	return { _tag: "FsError", message };
}

// ---------------------------------------------------------------------------
// TypeBox parameters (for AgentTool / ToolDefinition compatibility)
// ---------------------------------------------------------------------------

export const viewParameters = Type.Object({
	path: Type.String({
		description: "Relative path to an image file from cwd. Use $M/ prefix for scratchpad path.",
	}),
});

// ---------------------------------------------------------------------------
// Image reading utilities
// ---------------------------------------------------------------------------

/** Map file extension to mediaType. Returns null if unsupported. */
function extToMediaType(ext: string): ToolImage["mediaType"] | null {
	const e = ext.toLowerCase();
	switch (e) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		default:
			return null;
	}
}

/** Detect media type from file extension. Throws if unsupported. */
function detectMediaType(filePath: string): ToolImage["mediaType"] {
	const ext = extname(filePath);
	const mediaType = extToMediaType(ext);
	if (mediaType === null) {
		throw new Error(`Unsupported image type: ${ext}`);
	}
	return mediaType;
}

/** Read image dimensions from raw header bytes. */
function getImageDimensions(buffer: Buffer, mediaType: ToolImage["mediaType"]): { width: number; height: number } {
	if (mediaType === "image/png") {
		// PNG: IHDR chunk — width at bytes 16-19, height at bytes 20-23 (big-endian)
		if (buffer.length >= 24) {
			return {
				width: buffer.readUInt32BE(16),
				height: buffer.readUInt32BE(20),
			};
		}
	} else if (mediaType === "image/gif") {
		// GIF: width at bytes 6-7, height at bytes 8-9 (little-endian)
		if (buffer.length >= 10) {
			return {
				width: buffer.readUInt16LE(6),
				height: buffer.readUInt16LE(8),
			};
		}
	} else if (mediaType === "image/jpeg") {
		// JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker, then read dimensions
		let offset = 2; // Skip SOI marker (0xFFD8)
		while (offset < buffer.length - 1) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}
			const marker = buffer[offset + 1];
			// SOF markers: 0xC0–0xCF (except 0xC4, 0xC8, 0xCC which are DHT, JPG, DAC)
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				// After marker (2 bytes) + length (2 bytes) + precision (1 byte):
				// height at offset+5 (2 bytes big-endian), width at offset+7 (2 bytes big-endian)
				const dataOffset = offset + 5;
				if (dataOffset + 3 < buffer.length) {
					return {
						height: buffer.readUInt16BE(dataOffset),
						width: buffer.readUInt16BE(dataOffset + 2),
					};
				}
			}
			// Skip to next marker: read length field (2 bytes big-endian after marker)
			if (offset + 3 < buffer.length) {
				const segLen = buffer.readUInt16BE(offset + 2);
				offset += 2 + segLen;
			} else {
				break;
			}
		}
	} else if (mediaType === "image/webp") {
		// WebP: RIFF header at 0-3, file size at 4-7, "WEBP" at 8-11
		// VP8 lossy: "VP8 " at 12-15 → width/height at 26-29 (little-endian, 16-bit)
		// VP8L lossless: "VP8L" at 12-15 → width/height at 21-24 (14-bit packed)
		// VP8X extended: "VP8X" at 12-15 → width-1 at 24-26, height-1 at 27-29 (24-bit little-endian)
		if (
			buffer.length >= 30 &&
			buffer.toString("ascii", 0, 4) === "RIFF" &&
			buffer.toString("ascii", 8, 12) === "WEBP"
		) {
			const chunkType = buffer.toString("ascii", 12, 16);
			if (chunkType === "VP8 ") {
				// Lossy: width at 26-27, height at 28-29 (little-endian 16-bit, 14-bit used)
				if (buffer.length >= 30) {
					return {
						width: buffer.readUInt16LE(26) & 0x3fff,
						height: buffer.readUInt16LE(28) & 0x3fff,
					};
				}
			} else if (chunkType === "VP8L") {
				// Lossless: signature byte at 20, then 14-bit width-1, 14-bit height-1 packed
				if (buffer.length >= 25) {
					const b0 = buffer[21];
					const b1 = buffer[22];
					const b2 = buffer[23];
					const b3 = buffer[24];
					const widthM1 = (b0 << 0) | (b1 << 8) | ((b2 & 0x3f) << 16);
					const heightM1 = ((b2 >> 6) & 0x03) | (b3 << 2);
					return {
						width: widthM1 + 1,
						height: heightM1 + 1,
					};
				}
			} else if (chunkType === "VP8X") {
				// Extended: width-1 at 24-26, height-1 at 27-29 (24-bit little-endian)
				if (buffer.length >= 30) {
					const widthM1 = buffer[24] | (buffer[25] << 8) | (buffer[26] << 16);
					const heightM1 = buffer[27] | (buffer[28] << 8) | (buffer[29] << 16);
					return {
						width: widthM1 + 1,
						height: heightM1 + 1,
					};
				}
			}
		}
	}
	// Fallback: unknown dimensions
	return { width: 0, height: 0 };
}

/** Read an image file and return a ToolImage {base64, mediaType, width, height}. */
async function readImageFile(fullPath: string): Promise<ToolImage> {
	const mediaType = detectMediaType(fullPath);
	const buffer = await readFile(fullPath);
	const { width, height } = getImageDimensions(buffer, mediaType);
	return {
		base64: buffer.toString("base64"),
		mediaType,
		width,
		height,
	};
}

// ---------------------------------------------------------------------------
// defineViewHarnessTool — the 1:1 execution core
// ---------------------------------------------------------------------------

/**
 * Define the view tool as a HarnessTool.
 *
 * DEVIATION NOTE: The piki harness does not provide Effect services for
 * working directory or filesystem access. We closure-inject `cwd` and
 * `scratchpadPath` and use `fs.promises.readFile` directly instead of
 * yielding service tags. Effect services can be introduced later when
 * multiple tools share them.
 *
 * DEVIATION NOTE (SVG): The view tool description mentions SVG support, but
 * ToolImageSchema only allows png/jpeg/webp/gif media types. SVG files are
 * rejected with an FsError since there is no valid mediaType in the schema
 * for them.
 */
export function defineViewHarnessTool(cwd: string, scratchpadPath: string): HarnessTool<ViewInput, ToolImage, FsError> {
	return defineHarnessTool<ViewInput, ToolImage, FsError>({
		definition: {
			name: "view",
			description:
				"Read an image file and return it as image output for visual inspection. Supports PNG, JPEG, WebP, GIF, and SVG files.",
			inputSchema: ViewInputSchema,
			outputSchema: ViewOutputSchema,
		},
		execute: (input: ViewInput): Effect.Effect<ToolImage, FsError> =>
			Effect.gen(function* () {
				// 1. Expand scratchpad path ($M/ prefix)
				const expandedPath = expandScratchpadPath(input.path, scratchpadPath).path;

				// 2. Resolve to absolute path
				const fullPath = resolve(cwd, expandedPath);

				// 3. Read image — on failure, fail with FsError
				const image = yield* Effect.tryPromise({
					try: () => readImageFile(fullPath),
					catch: () => fsError(`Failed to read image: ${input.path}`),
				});

				// 4. Return ToolImage
				return image;
			}),
		stream: {
			// Synchronous validation — matches HarnessToolStream type signature (=> void).
			// Throws StreamValidationError if the file doesn't exist.
			onInput: (input: Partial<ViewInput>): void => {
				if (typeof input.path !== "string" || input.path.length === 0) return;
				const expandedPath = expandScratchpadPath(input.path, scratchpadPath).path;
				const fullPath = resolve(cwd, expandedPath);
				if (!existsSync(fullPath)) {
					throw new StreamValidationError({ message: `File not found: ${input.path}` });
				}
			},
		},
		errorSchema: FsErrorSchema,
	});
}

// ---------------------------------------------------------------------------
// createViewAgentTool — adapter conversion
// ---------------------------------------------------------------------------

/**
 * Convert the view HarnessTool into an AgentTool via the adapter.
 * Since outputSchema is ToolImageSchema, the default `formatHarnessOutput`
 * handles object output (returns JSON.stringify). No image block support
 * in the adapter — the ToolImage is available in `details` for the caller.
 */
export function createViewAgentTool(
	harnessTool: HarnessTool<ViewInput, ToolImage, FsError>,
): AgentTool<typeof viewParameters, ToolImage> {
	return harnessToolToAgentTool(harnessTool, {
		parameters: viewParameters,
		label: "view",
		mapInput: (args) => args as ViewInput,
		toContentBlocks: (output) => [
			{ type: "text", text: `Viewed image file [${output.mediaType}]` },
			{ type: "image", data: output.base64, mimeType: output.mediaType },
		],
	});
}
