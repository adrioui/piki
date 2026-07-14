import { relative, resolve, sep } from "node:path";

export interface ExpandedPath {
	readonly path: string;
	readonly expanded: boolean;
	readonly displayPath: string;
}

/** Expands `$M/` scratchpad path prefixes to absolute paths. */
export function expandScratchpadPath(inputPath: string, scratchpadPath: string): ExpandedPath {
	const notExpanded: ExpandedPath = { path: inputPath, expanded: false, displayPath: inputPath };
	if (inputPath === "") return notExpanded;
	let s = inputPath;
	while (s.startsWith("./")) s = s.slice(2);
	while (s.startsWith("../")) s = s.slice(3);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal $M path prefix token
	if (s === "$M" || s === "${M}") {
		return { path: scratchpadPath, expanded: true, displayPath: "" };
	}
	let innerPath: string | null = null;
	if (s.startsWith("$M/")) {
		innerPath = s.slice("$M/".length);
	} else {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal $M path prefix token
		if (s.startsWith("${M}/")) {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal $M path prefix token
			innerPath = s.slice("${M}/".length);
		}
	}
	if (innerPath === null) return notExpanded;
	const resolved = resolve(scratchpadPath, innerPath);
	if (resolved === scratchpadPath || resolved.startsWith(scratchpadPath + sep)) {
		const displayPath = relative(scratchpadPath, resolved);
		return { path: resolved, expanded: true, displayPath };
	}
	return notExpanded;
}
