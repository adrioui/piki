/**
 * Token estimation for text and image content.
 */

import { CHARS_PER_TOKEN_LOWER } from "../constants.ts";

/** Default token estimate for unmeasured images. */
export const DEFAULT_IMAGE_TOKENS = 1000;

/**
 * Minimal text part interface matching the `_tag`-discriminated type.
 * Structurally identical to `packages/ai/src/prompt/parts.ts` TextPart.
 */
export interface TextPart {
	readonly _tag: "TextPart";
	readonly text: string;
}

/**
 * Minimal image part interface matching the `_tag`-discriminated type.
 * Structurally identical to `packages/ai/src/prompt/parts.ts` ImagePart.
 */
export interface ImagePart {
	readonly _tag: "ImagePart";
	readonly data: string;
	readonly mediaType: string;
	readonly dimensions?: { readonly width: number; readonly height: number };
}

/**
 * Estimate the number of tokens for an image given its pixel dimensions.
 * Uses the merged-patch formula .
 */
export function estimateImageTokens(width: number, height: number): number {
	if (width == null || height == null) return DEFAULT_IMAGE_TOKENS;
	const mergedH = Math.ceil(Math.ceil(height / 14) / 2);
	const mergedW = Math.ceil(Math.ceil(width / 14) / 2);
	return mergedH * mergedW;
}

/**
 * Estimate the number of tokens for a plain text string.
 */
export function estimateText(s: string): number {
	if (!s) return 0;
	return Math.ceil(s.length / CHARS_PER_TOKEN_LOWER);
}

/**
 * Estimate the number of tokens for structured content (string or array of
 * text/image parts).
 */
export function estimateContentTokens(content: string | Array<TextPart | ImagePart>): number {
	if (typeof content === "string") {
		return Math.ceil(content.length / CHARS_PER_TOKEN_LOWER);
	}
	let tokens = 0;
	for (const part of content) {
		switch (part._tag) {
			case "TextPart":
				tokens += Math.ceil(part.text.length / CHARS_PER_TOKEN_LOWER);
				break;
			case "ImagePart":
				tokens += part.dimensions
					? estimateImageTokens(part.dimensions.width, part.dimensions.height)
					: DEFAULT_IMAGE_TOKENS;
				break;
		}
	}
	return tokens;
}
