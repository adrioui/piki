import { ContentBuilder, type ContentPart, type ImageMediaType, type ImagePart } from "../content.ts";

/** Check if a value looks like an image (has mediaType + data or base64). */
export function isImageValue(
	value: unknown,
): value is { mediaType: ImageMediaType; data?: string; base64?: string; width?: number; height?: number } {
	if (typeof value !== "object" || value === null) return false;
	const o = value as Record<string, unknown>;
	if (typeof o.mediaType !== "string") return false;
	if (
		o.mediaType !== "image/jpeg" &&
		o.mediaType !== "image/png" &&
		o.mediaType !== "image/gif" &&
		o.mediaType !== "image/webp"
	) {
		return false;
	}
	return typeof o.data === "string" || typeof o.base64 === "string";
}

/** Convert an image value into an ImagePart. */
export function toImagePart(value: {
	mediaType: ImageMediaType;
	data?: string;
	base64?: string;
	width?: number;
	height?: number;
}): ImagePart {
	const data = typeof value.data === "string" ? value.data : value.base64!;
	const { width: w, height: h } = value;
	const dimensions = typeof w === "number" && typeof h === "number" ? { width: w, height: h } : undefined;
	return {
		_tag: "ImagePart",
		data,
		mediaType: value.mediaType,
		...(dimensions ? { dimensions } : {}),
	};
}

/** Check if a value is a scalar (null, string, number, boolean). */
export function isScalar(value: unknown): value is null | string | number | boolean {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Render a scalar to its string representation. */
export function renderScalar(value: null | string | number | boolean): string {
	return String(value);
}

/** Recursively render a value into a ContentBuilder. Matches capture L76746-76772. */
export function renderValueInto(builder: ContentBuilder, value: unknown): void {
	if (value === undefined) return;
	if (isScalar(value)) {
		builder.pushText(renderScalar(value));
		return;
	}
	if (isImageValue(value)) {
		builder.pushPart(toImagePart(value));
		return;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			if (i > 0) builder.pushText("\n");
			renderFieldInto(builder, String(i), value[i]!);
		}
		return;
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).filter(([, v]) => v !== undefined);
		for (let i = 0; i < entries.length; i++) {
			if (i > 0) builder.pushText("\n");
			renderFieldInto(builder, entries[i]![0], entries[i]![1]);
		}
		return;
	}
	builder.pushText(String(value));
}

/** Render a named field into a ContentBuilder using XML-style tags. Matches capture L76773-76797. */
export function renderFieldInto(builder: ContentBuilder, name: string, value: unknown): void {
	if (isScalar(value)) {
		const raw = renderScalar(value);
		if (!raw.includes("\n")) {
			builder.pushText(`<${name}>${raw}</${name}>`);
		} else {
			builder.pushText(`<${name}>\n${raw}\n</${name}>`);
		}
		return;
	}
	builder.pushText(`<${name}>\n`);
	renderValueInto(builder, value);
	builder.pushText(`\n</${name}>`);
}

/** Render a tool output value into ContentParts. Matches capture L76798-76801. */
export function renderToolOutput(output: unknown): ContentPart[] {
	const builder = new ContentBuilder();
	renderValueInto(builder, output);
	return builder.build();
}

/** Render a tagged XML wrapper around a value. Matches capture L76802-76822. */
export function renderTagged(tag: string, value: unknown): ContentPart[] {
	const builder = new ContentBuilder();
	if (isScalar(value)) {
		const raw = renderScalar(value);
		if (!raw.includes("\n")) {
			builder.pushText(`<${tag}>${raw}</${tag}>`);
		} else {
			builder.pushText(`<${tag}>\n${raw}\n</${tag}>`);
		}
	} else {
		builder.pushText(`<${tag}>\n`);
		renderValueInto(builder, value);
		builder.pushText(`\n</${tag}>`);
	}
	return builder.build();
}
