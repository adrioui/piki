import type { AgentTool } from "@piki/agent-core";
import { Box, Container, Spacer, Text } from "@piki/tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	applyFlatReplaceAll,
	computeEditsDiff,
	detectLineEnding,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

const replaceEditSchema = Type.Object(
	{
		old: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].old in the same call.",
		}),
		new: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		old: Type.String({
			description:
				"Exact text to find and replace (alpha22 flat single-edit form). It must match the file exactly, including all whitespace and newlines. To replace multiple disjoint regions in one call, use the `edits` array instead.",
		}),
		new: Type.String({ description: "Replacement text for the matched `old` text." }),
		replaceAll: Type.Optional(
			Type.Boolean({
				description:
					"When true, replaces every occurrence of `old` in the file. When false or omitted, `old` must be unique; the edit fails if it appears more than once.",
			}),
		),
		edits: Type.Optional(
			Type.Array(replaceEditSchema, {
				description:
					"Legacy multi-edit form. One or more targeted replacements; each is matched against the original file, not incrementally. Prefer the top-level `old`/`new` unless you need multiple disjoint replacements in a single call. Do not include overlapping or nested edits.",
			}),
		),
	},
	{},
);

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/** Scratchpad directory, used to resolve $M/ paths with Magnitude-alpha22 parity. */
	scratchpadPath?: string;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = { ...(input as Record<string, unknown>) };

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {}
	}

	// Coerce replaceAll to a boolean (models sometimes send it as a string)
	if (args.replaceAll === true || args.replaceAll === "true") {
		args.replaceAll = true;
	} else {
		delete args.replaceAll;
	}

	// Fold top-level old/new (alpha22 flat single-edit form) into edits[]
	if (typeof args.old === "string" && typeof args.new === "string") {
		const edits = Array.isArray(args.edits) ? [...(args.edits as unknown[])] : [];
		edits.push({ old: args.old, new: args.new });
		args.edits = edits;
	}
	delete args.old;
	delete args.new;

	return args as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[]; replaceAll?: boolean } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error(
			"Edit tool input is invalid. Provide `old`/`new` for a single replacement, or `edits` with at least one entry.",
		);
	}
	const edits: Edit[] = input.edits.map((entry) => {
		const e = entry as Record<string, unknown>;
		const old = typeof e.old === "string" ? e.old : undefined;
		const new_ = typeof e.new === "string" ? e.new : undefined;
		if (typeof old !== "string" || typeof new_ !== "string") {
			throw new Error("Each edit must have old and new fields.");
		}
		return { old, new: new_ };
	});
	return { path: input.path, edits, replaceAll: input.replaceAll };
}

type RenderableEditEntry = { old?: string; new?: string };

type RenderableEditArgs = {
	path?: string;
	edits?: RenderableEditEntry[];
	old?: string;
	new?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : null;
	if (!path) {
		return null;
	}

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.old === "string" && typeof edit?.new === "string")
	) {
		return {
			path,
			edits: args.edits.map((edit) => ({ old: edit.old!, new: edit.new! })),
		};
	}

	if (typeof args.old === "string" && typeof args.new === "string") {
		return { path, edits: [{ old: args.old, new: args.new }] };
	}

	return null;
}

function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}

	return undefined;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) {
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));

	if (!component.preview) {
		return component;
	}

	const body =
		"error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	const scratchpadPath = options?.scratchpadPath ?? "";
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Provide `old` (exact text to find) and `new` (replacement text). By default `old` must be unique; set `replaceAll: true` to replace every occurrence. To change multiple disjoint regions in one call, pass the `edits` array instead.",
		promptSnippet: "Make precise file edits with exact text replacement (old/new, or multiple edits in one call)",
		promptGuidelines: [
			"Read the file (or the relevant region) before editing so old matches exactly.",
			"Use edit for precise changes; use write only for new files or full rewrites.",
			"`old` must match the original file exactly. Do not include leading/trailing whitespace you did not see; preserve the file's indentation and line endings.",
			"Keep `old` as small as possible while still being unique in the file. Do not pad with large unchanged regions just to connect distant changes.",
			"For repeated/near-identical blocks (e.g. several list items, similar JSX nodes), include enough unique surrounding lines to disambiguate which occurrence you mean.",
			"When changing multiple separate locations in one file at once, set `replaceAll: true` (if every occurrence is identical) or pass multiple entries in the `edits` array instead of making multiple edit calls. Do not emit overlapping or nested edits; merge nearby changes into one edit.",
			"If an edit fails, re-read the relevant region before retrying. Do not retry identical arguments blindly.",
			"After every edit, re-read the changed region (or the full file if small) and confirm the change landed as intended.",
		],
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		stream: {
			onInput: (input: unknown): void => {
				const typedInput = input as Partial<EditToolInput>;
				if (typeof typedInput?.path !== "string" || typedInput.path.length === 0) return;
				try {
					const absolutePath = resolveToolPath(typedInput.path, cwd, scratchpadPath);
					ops.access(absolutePath);
				} catch {
					throw new Error(`File not found: ${typedInput.path}`);
				}
			},
		},
		emissionSchema: undefined,
		errorSchema: undefined,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path, edits, replaceAll } = validateEditInput(input);
			const absolutePath = resolveToolPath(path, cwd, scratchpadPath);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Check if file exists.
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// Read the file.
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in old.
				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);

				// Alpha22 flat form: a single old/new with replaceAll. Use split/join
				// semantics (replace every occurrence) instead of the unique-match path.
				const flatSingle = replaceAll && edits.length === 1 && typeof edits[0].new === "string";
				const { baseContent, newContent } = flatSingle
					? applyFlatReplaceAll(normalizedContent, edits[0], path)
					: applyEditsToNormalizedContent(normalizedContent, edits, path);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);

				// Mirror Magnitude alpha22's edit-tool success wording. Derive the
				// counts from the applied content so multi-occurrence (`replaceAll`)
				// and pure-delete edits are reported faithfully.
				const removedLines = edits.reduce((sum, e) => sum + e.old.split("\n").length, 0);
				const addedLines = edits.reduce((sum, e) => sum + e.new.split("\n").length, 0);
				const replacedCount = flatSingle
					? normalizedContent.split(normalizeToLF(edits[0]!.old)).length - 1
					: edits.length;
				let editText: string;
				if (replacedCount > 1) {
					editText = `Replaced ${replacedCount} occurrences in ${path}`;
				} else if (addedLines === 0 && removedLines > 0) {
					editText = `Deleted ${removedLines} line(s) from ${path}`;
				} else {
					editText = `Replaced ${removedLines} line(s) with ${addedLines} line(s) in ${path}`;
				}

				return {
					content: [{ type: "text", text: editText }],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestKey = argsKey;
				void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd, scratchpadPath).then(
					(preview) => {
						if (component.previewArgsKey === requestKey) {
							setEditPreview(component, preview, requestKey);
							context.invalidate();
						}
					},
				);
			}

			return buildEditCallComponent(component, args, theme, context.cwd);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
							argsKey,
						) || changed;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					buildEditCallComponent(
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
					);
				}
			}

			const output = formatEditResult(context.args, callComponent?.preview, typedResult, theme, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
