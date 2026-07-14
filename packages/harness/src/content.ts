/** A single part of a tool output content block. */
export type ContentPart = TextPart | ImagePart;

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface TextPart {
	_tag: "TextPart";
	text: string;
}

export interface ImagePart {
	_tag: "ImagePart";
	data: string;
	mediaType: ImageMediaType;
	dimensions?: { width: number; height: number };
}

/** Builder for accumulating content parts, coalescing adjacent text. Matches capture L76672-76701. */
export class ContentBuilder {
	private parts: ContentPart[] = [];

	pushText(text: string): void {
		if (!text) return;
		const last = this.parts[this.parts.length - 1];
		if (last?._tag === "TextPart") {
			this.parts[this.parts.length - 1] = { _tag: "TextPart", text: last.text + text };
		} else {
			this.parts.push({ _tag: "TextPart", text });
		}
	}

	pushPart(part: ContentPart): void {
		if (part._tag === "TextPart") {
			this.pushText(part.text);
		} else {
			this.parts.push(part);
		}
	}

	pushParts(parts: ContentPart[]): void {
		for (const part of parts) this.pushPart(part);
	}

	hasContent(): boolean {
		return this.parts.length > 0;
	}

	build(): ContentPart[] {
		return [...this.parts];
	}
}
