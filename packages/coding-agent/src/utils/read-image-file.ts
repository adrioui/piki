// File-path → LLM-vision reader. Thin wrapper over resizeImage +
// detectSupportedImageMimeTypeFromFile that uses pi's photon pipeline
// instead of Bun.Image.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { type ImageResizeOptions, type ResizedImage, resizeImage } from "./image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "./mime.ts";

export interface ReadImageFileOptions {
	/** Max long-edge in px (default 1568; pi's resizeImage default is 2000). */
	maxLongEdge?: number;
	/** JPEG quality for fallback JPEG encode. Default 80 (pi's resizeImage default). */
	jpegQuality?: number;
	/** Max base64-payload size in bytes. Default 4.5 MB (pi's resizeImage default; Anthropic 5MB headroom). */
	maxEncodedBytes?: number;
	/** Pass SVG through as base64 with mediaType "image/png". Default true. */
	allowSvgPassthrough?: boolean;
}

export interface ImageForModel {
	base64: string;
	mediaType: string;
	width: number;
	height: number;
}

const DEFAULT_MAX_LONG_EDGE = 1568;
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

/**
 * Read an image file and prepare it for LLM vision input.
 *
 * SVG → passthrough (base64, mediaType "image/png", width/height 0).
 *   Preserves the deliberate "model re-rasterises" assumption.
 * Raster (PNG/JPEG/GIF/WEBP) → delegate to pi's resizeImage (photon + worker).
 * Unknown format → throw.
 */
export async function readImageFileForModel(
	absolutePath: string,
	options?: ReadImageFileOptions,
): Promise<ImageForModel> {
	const maxLongEdge = options?.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;
	const jpegQuality = options?.jpegQuality ?? 80;
	const maxEncodedBytes = options?.maxEncodedBytes ?? DEFAULT_MAX_BYTES;
	const allowSvg = options?.allowSvgPassthrough ?? true;

	const buf = new Uint8Array(await readFile(absolutePath));

	// SVG: photon/mime sniffers return null; pass the bytes through unchanged.
	const lower = basename(absolutePath).toLowerCase();
	if (allowSvg && lower.endsWith(".svg")) {
		return {
			base64: Buffer.from(buf).toString("base64"),
			mediaType: "image/png",
			width: 0,
			height: 0,
		};
	}

	const detected = await detectSupportedImageMimeTypeFromFile(absolutePath);
	if (!detected) {
		throw new Error(`Unsupported or unknown image format: ${absolutePath}`);
	}

	const resizeOpts: ImageResizeOptions = {
		maxWidth: maxLongEdge,
		maxHeight: maxLongEdge,
		maxBytes: maxEncodedBytes,
		jpegQuality,
	};
	const resized: ResizedImage | null = await resizeImage(buf, detected, resizeOpts);
	if (!resized) {
		// resizeImage returns null when photon unavailable or target too large.
		// Fall back to sending the original bytes.
		return {
			base64: Buffer.from(buf).toString("base64"),
			mediaType: detected,
			width: 0,
			height: 0,
		};
	}
	return {
		base64: resized.data,
		mediaType: resized.mimeType,
		width: resized.width,
		height: resized.height,
	};
}
