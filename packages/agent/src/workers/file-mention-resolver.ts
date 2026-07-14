// packages/agent/src/workers/file-mention-resolver.ts
//
// FileMentionResolver worker.
//
// The worker subscribes to `user_message` events, resolves any attachments of
// type "mention" against the session cwd + scratchpad, and re-publishes a
// `user_message_ready` event carrying the resolved mention contents.
//
// Services used:
//   - `Fs` (Context.Tag("Fs")) — readFile / stat / walk over node:fs.
//   - `SessionContextProjection` — projection exposing `{ cwd, scratchpadPath }`.
//   - `logger` — Effect logger.
//
// piki does not yet have a shared `Fs` service or `SessionContextProjection`, so
// this file is self-contained: it defines a local `Fs` service and a local
// `SessionContextProjection` projection, and merges the `Fs` layer into the
// worker's `Layer`. Branding stays "piki".

import { readFile, stat } from "node:fs/promises";
import { extname, relative, sep } from "node:path";
import { defineWorker } from "@piki/event-core";
import { Logger } from "@piki/logger";
import { expandScratchpadPath } from "@piki/scratchpad";
import { Context, Effect, Layer } from "effect";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_MENTION_TEXT_BYTES = 500 * 1024;

const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

// ─── Path utilities ───────────────────────────────────────────────────────────

function isPathUnderPrefix(absolutePath: string, prefix: string): boolean {
	const rel = relative(prefix, absolutePath);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && rel !== "" ? true : absolutePath === prefix;
}

function isPathAllowed(absolutePath: string, cwd: string, allowedPrefixes: string[]): boolean {
	if (isPathUnderPrefix(absolutePath, cwd)) return true;
	if (!allowedPrefixes || allowedPrefixes.length === 0) return false;
	return allowedPrefixes.some((prefix) => isPathUnderPrefix(absolutePath, prefix));
}

const SCRATCHPAD_PREFIX_BRACED = "$" + "{M}/";
const SCRATCHPAD_PREFIX_PLAIN = "$M/";

function resolveFileRefPath(
	refPath: string,
	cwd: string,
	scratchpadPath: string,
): { resolvedPath: string; displayPath: string } | null {
	let normalized = refPath;
	if (normalized.startsWith("./")) normalized = normalized.slice(2);
	const explicitScratchpadPrefix =
		normalized.startsWith(SCRATCHPAD_PREFIX_PLAIN) || normalized.startsWith(SCRATCHPAD_PREFIX_BRACED);
	const prefix = normalized.startsWith(SCRATCHPAD_PREFIX_BRACED)
		? SCRATCHPAD_PREFIX_BRACED
		: normalized.startsWith(SCRATCHPAD_PREFIX_PLAIN)
			? SCRATCHPAD_PREFIX_PLAIN
			: "";
	const body = explicitScratchpadPrefix ? normalized.slice(prefix.length) : normalized;
	if (body.length === 0) return null;

	if (explicitScratchpadPrefix) {
		const result = expandScratchpadPath(`$M/${body}`, scratchpadPath);
		if (result.expanded) {
			return { resolvedPath: result.path, displayPath: result.displayPath };
		}
	}
	const projectResolved = `${cwd}/${body}`;
	return { resolvedPath: projectResolved, displayPath: body };
}

// ─── Fs service ───────────────────────────────────────────────────────────────

export class FsError extends Error {
	readonly operation: string;
	readonly path: string;
	readonly cause: unknown;
	constructor(operation: string, path: string, cause: unknown) {
		super(`FsError: ${operation} on ${path}`);
		this.name = "FsError";
		this.operation = operation;
		this.path = path;
		this.cause = cause;
	}
}

export interface Fs {
	readonly readFile: (path: string) => Effect.Effect<Buffer, FsError>;
	readonly stat: (path: string) => Effect.Effect<import("node:fs").Stats, FsError>;
}

export const Fs = Context.Tag("piki/agent/Fs")<never, Fs>();

const makeFsLive = Layer.succeed(Fs, {
	readFile: (path) =>
		Effect.tryPromise({
			try: () => readFile(path),
			catch: (cause) => new FsError("readFile", path, cause),
		}),
	stat: (path) =>
		Effect.tryPromise({
			try: () => stat(path),
			catch: (cause) => new FsError("stat", path, cause),
		}),
});

// ─── Session context projection ──────────────────────────────────────────────
//
// Reuses the shared SessionContextProjection from `../projections/session-context.ts`
// rather than redefining it here, to avoid a duplicate projection registration.

import { SessionContextProjection } from "../projections/session-context.ts";

// ─── Mention resolution types ────────────────────────────────────────────────

interface MentionAttachment {
	path: string;
	type: "mention";
	contentType: "text" | "image" | "directory";
	lineRange?: { start: number; end: number };
}

interface ResolvedMention {
	path: string;
	contentType: "text" | "image" | "directory";
	content: string;
	truncated?: true;
	originalBytes?: number;
	lineRange?: { start: number; end: number };
	error?: string;
}

// ─── Mention resolution ───────────────────────────────────────────────────────

async function resolveTextMention(
	path: string,
	absolutePath: string,
	fs: Fs,
	lineRange?: { start: number; end: number },
): Promise<ResolvedMention> {
	const buffer = await fs.readFile(absolutePath).pipe(Effect.runPromise);
	const originalBytes = buffer.byteLength;
	const truncated = originalBytes > MAX_MENTION_TEXT_BYTES;
	const contentBuffer = truncated ? buffer.subarray(0, MAX_MENTION_TEXT_BYTES) : buffer;
	let content = contentBuffer.toString("utf8");
	if (lineRange) {
		const lines = content.split("\n");
		const start = Math.max(1, lineRange.start);
		const end = Math.min(lines.length, lineRange.end);
		if (start <= end) {
			content = lines.slice(start - 1, end).join("\n");
		} else {
			content = "";
		}
	}
	return {
		path,
		contentType: "text",
		content,
		truncated: truncated || undefined,
		originalBytes,
		lineRange: lineRange || undefined,
	};
}

async function resolveImageMention(path: string, absolutePath: string, fs: Fs): Promise<ResolvedMention> {
	const extension = extname(absolutePath).toLowerCase();
	const mime = IMAGE_MIME_TYPES[extension] ?? "application/octet-stream";
	const buffer = await fs.readFile(absolutePath).pipe(Effect.runPromise);
	const base64 = buffer.toString("base64");
	return {
		path,
		contentType: "image",
		content: `data:${mime};base64,${base64}`,
	};
}

async function resolveDirectoryMention(path: string, absolutePath: string, fs: Fs): Promise<ResolvedMention> {
	const entries = await fs.stat(absolutePath).pipe(Effect.runPromise);
	void entries;
	const lines: string[] = [];
	// Directory listing is produced from a shallow stat walk of the resolved path.
	// No `Fs.walk` is available here, so we emit a minimal tree
	// entry describing the directory root.
	lines.push(`<entry path="" name="${absolutePath}" type="dir" depth="0" />`);
	const content = `<tree>${lines.join("")}</tree>`;
	return {
		path,
		contentType: "directory",
		content,
	};
}

async function resolveMention(
	cwd: string,
	scratchpadPath: string,
	attachment: MentionAttachment,
	fs: Fs,
	allowedPrefixes: string[],
): Promise<ResolvedMention> {
	const resolved = resolveFileRefPath(attachment.path, cwd, scratchpadPath);
	if (!resolved) {
		throw new Error(`Path not found: ${attachment.path}`);
	}
	const absolutePath = resolved.resolvedPath;
	if (!isPathAllowed(absolutePath, cwd, allowedPrefixes)) {
		throw new Error(`Path is outside cwd: ${attachment.path}`);
	}
	const fileStat = await fs.stat(absolutePath).pipe(Effect.runPromise);
	if (attachment.contentType === "directory") {
		if (!fileStat.isDirectory()) throw new Error(`Mention is not a directory: ${attachment.path}`);
		return resolveDirectoryMention(attachment.path, absolutePath, fs);
	}
	if (fileStat.isDirectory()) {
		throw new Error(`Mention expected file but got directory: ${attachment.path}`);
	}
	if (attachment.contentType === "image") {
		return resolveImageMention(attachment.path, absolutePath, fs);
	}
	return resolveTextMention(attachment.path, absolutePath, fs, attachment.lineRange);
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export const FileMentionResolver = defineWorker()({
	name: "FileMentionResolver",
	eventHandlers: {
		user_message: (event, publish, read) =>
			Effect.gen(function* () {
				const mentions = (event.attachments ?? []).filter(
					(attachment: MentionAttachment) => attachment.type === "mention",
				);
				if (mentions.length === 0) {
					yield* publish({
						type: "user_message_ready",
						messageId: event.messageId,
						forkId: event.forkId,
						resolvedMentions: [],
					});
					return;
				}
				const fs = yield* Fs;
				const sessionContext = yield* read(SessionContextProjection);
				const cwd = sessionContext.context?.cwd;
				const scratchpadPath = sessionContext.context?.scratchpadPath;
				if (!scratchpadPath) throw new Error("scratchpadPath not available in session context");
				const resolvedMentions = yield* Effect.promise(async () => {
					const results: ResolvedMention[] = [];
					for (const mention of mentions) {
						if (!cwd) {
							results.push({
								path: mention.path,
								contentType: mention.contentType,
								content: "",
								error: "Missing session cwd",
							});
							continue;
						}
						try {
							results.push(await resolveMention(cwd, scratchpadPath, mention, fs, [scratchpadPath]));
						} catch (error) {
							results.push({
								path: mention.path,
								contentType: mention.contentType,
								content: "",
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
					return results;
				});
				yield* publish({
					type: "user_message_ready",
					messageId: event.messageId,
					forkId: event.forkId,
					resolvedMentions,
				});
			}).pipe(
				Effect.catchAllCause((cause) =>
					Effect.gen(function* () {
						const logger = yield* Logger;
						const scoped = yield* logger.namespace("FileMentionResolver");
						yield* scoped.log("error", {
							message: "Unexpected error while resolving file mentions",
							cause: cause.toString(),
						});
					}),
				),
			),
	},
}).Layer.pipe(Layer.provideMerge(makeFsLive));
