/**
 * Incremental JSON tokenizer.
 */

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER_CHARS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "+", "-", "e", "E"]);
const NUMBER_START = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "-"]);
const DELIMITERS = new Set(["{", "}", "[", "]", ":", ",", '"', " ", "\t", "\n", "\r"]);
const COMPLETE_NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const ESCAPE_MAP: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	b: "\b",
	f: "\f",
	"\\": "\\",
	'"': '"',
	"/": "/",
};

export type Token =
	| { _tag: "objectOpen" }
	| { _tag: "objectClose" }
	| { _tag: "arrayOpen" }
	| { _tag: "arrayClose" }
	| { _tag: "colon" }
	| { _tag: "comma" }
	| { _tag: "string"; value: string; complete: boolean }
	| { _tag: "number"; value: string; complete: boolean }
	| { _tag: "true" }
	| { _tag: "false" }
	| { _tag: "null" }
	| { _tag: "unquotedString"; value: string; complete: boolean };

type Mode =
	| { _tag: "default" }
	| { _tag: "inString"; content: string; pendingEscape: boolean; pendingUnicodeHex: string | null }
	| { _tag: "inNumber"; content: string }
	| { _tag: "inKeyword"; content: string; candidates: string[] }
	| { _tag: "inUnquoted"; content: string };

function isCompleteNumber(s: string): boolean {
	return COMPLETE_NUMBER_RE.test(s);
}

export function createJsonTokenizer(onToken: (token: Token) => void) {
	let mode: Mode = { _tag: "default" };

	function emitKeywordOrUnquoted(content: string) {
		switch (content) {
			case "true":
				onToken({ _tag: "true" });
				break;
			case "false":
				onToken({ _tag: "false" });
				break;
			case "null":
				onToken({ _tag: "null" });
				break;
			default:
				onToken({ _tag: "unquotedString", value: content, complete: true });
				break;
		}
	}

	function processChar(ch: string): boolean {
		switch (mode._tag) {
			case "default": {
				switch (ch) {
					case "{":
						onToken({ _tag: "objectOpen" });
						return true;
					case "}":
						onToken({ _tag: "objectClose" });
						return true;
					case "[":
						onToken({ _tag: "arrayOpen" });
						return true;
					case "]":
						onToken({ _tag: "arrayClose" });
						return true;
					case ":":
						onToken({ _tag: "colon" });
						return true;
					case ",":
						onToken({ _tag: "comma" });
						return true;
					case '"':
						mode = { _tag: "inString", content: "", pendingEscape: false, pendingUnicodeHex: null };
						return true;
					default:
						if (WHITESPACE.has(ch)) return true;
						if (NUMBER_START.has(ch)) {
							mode = { _tag: "inNumber", content: ch };
							return true;
						}
						if (ch === "t") {
							mode = { _tag: "inKeyword", content: "t", candidates: ["true"] };
							return true;
						}
						if (ch === "f") {
							mode = { _tag: "inKeyword", content: "f", candidates: ["false"] };
							return true;
						}
						if (ch === "n") {
							mode = { _tag: "inKeyword", content: "n", candidates: ["null"] };
							return true;
						}
						mode = { _tag: "inUnquoted", content: ch };
						return true;
				}
			}
			case "inString": {
				if (mode.pendingUnicodeHex !== null) {
					mode.pendingUnicodeHex += ch;
					if (mode.pendingUnicodeHex.length === 4) {
						const hex = mode.pendingUnicodeHex;
						const code = Number.parseInt(hex, 16);
						if (Number.isNaN(code)) {
							mode.content += `\\u${hex}`;
						} else {
							mode.content += String.fromCharCode(code);
						}
						mode.pendingUnicodeHex = null;
					}
					return true;
				}
				if (mode.pendingEscape) {
					mode.pendingEscape = false;
					if (ch === "u") {
						mode.pendingUnicodeHex = "";
						return true;
					}
					const mapped = ESCAPE_MAP[ch];
					mode.content += mapped !== undefined ? mapped : `\\${ch}`;
					return true;
				}
				if (ch === "\\") {
					mode.pendingEscape = true;
					return true;
				}
				if (ch === '"') {
					onToken({ _tag: "string", value: mode.content, complete: true });
					mode = { _tag: "default" };
					return true;
				}
				mode.content += ch;
				return true;
			}
			case "inNumber": {
				if (NUMBER_CHARS.has(ch)) {
					mode.content += ch;
					return true;
				}
				onToken({ _tag: "number", value: mode.content, complete: isCompleteNumber(mode.content) });
				mode = { _tag: "default" };
				return false;
			}
			case "inKeyword": {
				const pos = mode.content.length;
				const newCandidates = mode.candidates.filter((c) => pos < c.length && c[pos] === ch);
				if (newCandidates.length === 0) {
					const fullMatch = mode.candidates.find((c) => c.length === pos);
					if (fullMatch) {
						if (DELIMITERS.has(ch)) {
							emitKeywordOrUnquoted(fullMatch);
							mode = { _tag: "default" };
							return false;
						}
						mode = { _tag: "inUnquoted", content: mode.content + ch };
						return true;
					}
					mode = { _tag: "inUnquoted", content: mode.content + ch };
					return true;
				}
				mode.content += ch;
				mode.candidates = newCandidates;
				return true;
			}
			case "inUnquoted": {
				if (DELIMITERS.has(ch)) {
					onToken({ _tag: "unquotedString", value: mode.content, complete: true });
					mode = { _tag: "default" };
					return false;
				}
				mode.content += ch;
				return true;
			}
		}
	}

	return {
		push(chunk: string) {
			for (let i = 0; i < chunk.length; i++) {
				const consumed = processChar(chunk[i]);
				if (!consumed) {
					i--;
				}
			}
		},
		end() {
			switch (mode._tag) {
				case "default":
					break;
				case "inString":
					onToken({ _tag: "string", value: mode.content, complete: false });
					break;
				case "inNumber":
					onToken({ _tag: "number", value: mode.content, complete: isCompleteNumber(mode.content) });
					break;
				case "inKeyword": {
					const currentContent = mode.content;
					const fullMatch = mode.candidates.find((c) => c === currentContent);
					if (fullMatch) {
						emitKeywordOrUnquoted(fullMatch);
					} else {
						onToken({ _tag: "unquotedString", value: currentContent, complete: false });
					}
					break;
				}
				case "inUnquoted":
					onToken({ _tag: "unquotedString", value: mode.content, complete: true });
					break;
			}
			mode = { _tag: "default" };
		},
		get pending(): { _tag: string; content: string } | null {
			const m = mode;
			switch (m._tag) {
				case "default":
					return null;
				case "inString":
					return { _tag: "string", content: m.content };
				case "inNumber":
					return { _tag: "number", content: m.content };
				case "inKeyword":
					return { _tag: "keyword", content: m.content };
				case "inUnquoted":
					return { _tag: "unquoted", content: m.content };
				default:
					return null;
			}
		},
	};
}
