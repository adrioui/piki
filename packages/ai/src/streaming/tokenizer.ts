/**
 * Character-by-character JSON tokenizer for incremental streaming.
 *
 * Processes one character at a time and emits tokens as they become available.
 * Designed to handle partial JSON from LLM streaming output, emitting tokens
 * incrementally as characters arrive. Supports snapshot/restore for rollback.
 */

export type TokenType =
	| "object_start"
	| "object_end"
	| "array_start"
	| "array_end"
	| "key"
	| "string"
	| "number"
	| "literal"
	| "colon"
	| "comma"
	| "eof";

export interface Token {
	type: TokenType;
	value: string;
	/** Character offset where this token started in the feed stream. */
	offset: number;
}

const JSON_ESCAPE_MAP: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	b: "\b",
	f: "\f",
	'"': '"',
	"\\": "\\",
	"/": "/",
};
type TokenSink = (token: Token) => void;

/** Snapshot of tokenizer state for restore(). */
interface TokenizerSnapshot {
	offset: number;
	inString: boolean;
	stringBuffer: string;
	escapeNext: boolean;
	unicodeBuffer: string;
	inNumber: boolean;
	numberBuffer: string;
	literalBuffer: string;
}

export class JsonTokenizer {
	private readonly sink: TokenSink;
	private offset = 0;

	private inString = false;
	private stringBuffer = "";
	private escapeNext = false;
	private unicodeBuffer = "";

	private inNumber = false;
	private numberBuffer = "";

	private literalBuffer = "";

	/** Pending incomplete value (half-streamed string/number/literal). */
	pendingValue: string | undefined;

	constructor(sink: TokenSink) {
		this.sink = sink;
	}

	feed(chunk: string): void {
		for (const char of chunk) {
			this.feedChar(char);
		}
		this.updatePendingValue();
	}

	flush(): void {
		this.flushPending();
		this.sink({ type: "eof", value: "", offset: this.offset });
	}

	snapshot(): TokenizerSnapshot {
		return {
			offset: this.offset,
			inString: this.inString,
			stringBuffer: this.stringBuffer,
			escapeNext: this.escapeNext,
			unicodeBuffer: this.unicodeBuffer,
			inNumber: this.inNumber,
			numberBuffer: this.numberBuffer,
			literalBuffer: this.literalBuffer,
		};
	}

	restore(snap: TokenizerSnapshot): void {
		this.offset = snap.offset;
		this.inString = snap.inString;
		this.stringBuffer = snap.stringBuffer;
		this.escapeNext = snap.escapeNext;
		this.unicodeBuffer = snap.unicodeBuffer;
		this.inNumber = snap.inNumber;
		this.numberBuffer = snap.numberBuffer;
		this.literalBuffer = snap.literalBuffer;
		this.updatePendingValue();
	}

	private updatePendingValue(): void {
		if (this.inString) {
			this.pendingValue = this.stringBuffer;
		} else if (this.inNumber) {
			this.pendingValue = this.numberBuffer;
		} else if (this.literalBuffer.length > 0) {
			this.pendingValue = this.literalBuffer;
		} else {
			this.pendingValue = undefined;
		}
	}

	private feedChar(char: string): void {
		if (this.inString) {
			this.feedStringChar(char);
			this.offset++;
			return;
		}

		if (this.inNumber) {
			if (/[0-9eE+\-.]/.test(char)) {
				this.numberBuffer += char;
				this.offset++;
				return;
			}
			this.flushNumber();
		}

		if (this.literalBuffer.length > 0) {
			if (/[a-zA-Z]/.test(char)) {
				this.literalBuffer += char;
				this.offset++;
				return;
			}
			this.flushLiteral();
		}

		switch (char) {
			case "{":
				this.emit("object_start", char);
				break;
			case "}":
				this.emit("object_end", char);
				break;
			case "[":
				this.emit("array_start", char);
				break;
			case "]":
				this.emit("array_end", char);
				break;
			case ":":
				this.emit("colon", char);
				break;
			case ",":
				this.emit("comma", char);
				break;
			case '"':
				this.inString = true;
				this.stringBuffer = "";
				this.escapeNext = false;
				break;
			default:
				if (/\s/.test(char)) break;
				if (char === "-" || /[0-9]/.test(char)) {
					this.inNumber = true;
					this.numberBuffer = char;
					break;
				}
				if (/[a-zA-Z]/.test(char)) {
					this.literalBuffer = char;
					break;
				}
				break;
		}
		this.offset++;
	}

	private feedStringChar(char: string): void {
		if (this.unicodeBuffer.length > 0) {
			const next = this.unicodeBuffer === "u" ? char : this.unicodeBuffer + char;
			if (!/^[0-9a-fA-F]{1,4}$/.test(next)) {
				this.stringBuffer += `\\u${this.unicodeBuffer === "u" ? "" : this.unicodeBuffer}${char}`;
				this.unicodeBuffer = "";
				return;
			}
			if (next.length === 4) {
				this.stringBuffer += String.fromCharCode(Number.parseInt(next, 16));
				this.unicodeBuffer = "";
			} else {
				this.unicodeBuffer = next;
			}
			return;
		}

		if (this.escapeNext) {
			if (char === "u") {
				this.unicodeBuffer = "u";
			} else {
				this.stringBuffer += JSON_ESCAPE_MAP[char] ?? char;
			}
			this.escapeNext = false;
			return;
		}

		if (char === "\\") {
			this.escapeNext = true;
			return;
		}

		if (char === '"') {
			this.emit("string", this.stringBuffer);
			this.inString = false;
			this.stringBuffer = "";
			return;
		}

		this.stringBuffer += char;
	}

	private flushPending(): void {
		if (this.inString) {
			this.emit("string", this.stringBuffer);
			this.inString = false;
			this.stringBuffer = "";
		}
		if (this.inNumber) {
			this.flushNumber();
		}
		if (this.literalBuffer.length > 0) {
			this.flushLiteral();
		}
		this.pendingValue = undefined;
	}

	private flushNumber(): void {
		if (this.numberBuffer.length > 0) {
			this.emit("number", this.numberBuffer);
		}
		this.inNumber = false;
		this.numberBuffer = "";
	}

	private flushLiteral(): void {
		const buf = this.literalBuffer;
		this.literalBuffer = "";
		if (buf === "true" || buf === "false" || buf === "null") {
			this.emit("literal", buf);
		}
	}

	private emit(type: TokenType, value: string): void {
		this.sink({ type, value, offset: this.offset - (value.length > 1 ? value.length - 1 : 0) });
		this.updatePendingValue();
	}
}
