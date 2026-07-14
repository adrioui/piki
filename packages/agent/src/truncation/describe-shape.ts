/**
 * Human-readable shape description for prompt representation.
 *
 * Produces indented, annotated output that describes the shape and size
 * of a JSON-serialisable value within a token budget.
 */

import { CHARS_PER_TOKEN_UPPER } from "../constants.ts";
import { allocateBudget, charsToTokensUpper } from "./budget.ts";
import { estimateText } from "./estimate.ts";
import { formatSize } from "./format.ts";
import { measureBounded } from "./json/measure.ts";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const DEFAULT_BUDGET = 500;
export const INDENT = "  ";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function describeShape(value: unknown, budgetTokens: number = DEFAULT_BUDGET): string {
	return renderValue(value, budgetTokens, 0);
}

// ---------------------------------------------------------------------------
// Internal: type-dispatch hub
// ---------------------------------------------------------------------------

function renderValue(value: unknown, budget: number, depth: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return renderString(value, budget);
	if (Array.isArray(value)) return renderArray(value, budget, depth);
	if (typeof value === "object") return renderObject(value as Record<string, unknown>, budget, depth);
	return "...";
}

// ---------------------------------------------------------------------------
// Internal: string rendering with shape annotation fallback
// ---------------------------------------------------------------------------

function renderString(s: string, budget: number): string {
	const full = JSON.stringify(s);
	const fullCost = charsToTokensUpper(full.length);
	if (fullCost <= budget) return full;

	const budgetChars = budget * CHARS_PER_TOKEN_UPPER;

	// Very long string → shape annotation
	if (s.length > budgetChars * 4) {
		const tokens = formatSize(estimateText(s));
		return `<string, ${s.length} chars, ~${tokens} tokens>`;
	}

	// Truncated JSON with ellipsis suffix
	const availableChars = budgetChars - 5;
	if (availableChars <= 0) return `<string, ${s.length} chars>`;
	const prefix = s.slice(0, Math.floor(availableChars));
	return `${JSON.stringify(prefix).slice(0, -1)}..."`;
}

// ---------------------------------------------------------------------------
// Internal: array rendering
// ---------------------------------------------------------------------------

function renderArray(arr: unknown[], budget: number, depth: number): string {
	if (arr.length === 0) return "[]";

	const measured = measureBounded(arr, budget);
	if (!measured.exceeded) return renderFull2(arr, depth);

	const framingCost = 3;
	const available = budget - framingCost;
	if (available <= 0) return `[<${arr.length} items>...]`;

	const isHomogeneous = checkHomogeneous2(arr);
	let itemCount: number;
	let minPerItem: number;

	if (isHomogeneous) {
		itemCount = Math.min(2, arr.length);
		minPerItem = 20;
	} else {
		itemCount = Math.min(5, arr.length);
		minPerItem = 10;
	}

	while (itemCount > 1 && available / itemCount < minPerItem) {
		itemCount--;
	}

	if (available < minPerItem) return `[<${arr.length} items>...]`;

	const separatorCost = itemCount - 1;
	const itemBudget = available - separatorCost;
	const measurements = arr.slice(0, itemCount).map((v) => measureBounded(v, itemBudget));
	const allocations = allocateBudget(measurements, itemBudget);

	const ind = INDENT.repeat(depth + 1);
	const baseInd = INDENT.repeat(depth);

	let result = `[<${arr.length} items>\n`;
	for (let i = 0; i < itemCount; i++) {
		const rendered = renderValue(arr[i], allocations[i], depth + 1);
		const comma = i < itemCount - 1 || itemCount < arr.length ? "," : "";
		result += `${ind + indentSubsequentLines(rendered, depth + 1) + comma}\n`;
	}
	if (itemCount < arr.length) {
		result += `${ind}...${arr.length - itemCount} more\n`;
	}
	result += `${baseInd}]`;
	return result;
}

// ---------------------------------------------------------------------------
// Internal: object rendering
// ---------------------------------------------------------------------------

function renderObject(obj: Record<string, unknown>, budget: number, depth: number): string {
	const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
	if (entries.length === 0) return "{}";

	const measured = measureBounded(obj, budget);
	if (!measured.exceeded) return renderFull2(obj, depth);

	const framingCost = 2;
	const available = budget - framingCost;
	if (available <= 0) return `{<${entries.length} keys>...}`;

	const keyOverheads = entries.map(([k], i) => {
		const sep = i > 0 ? 1 : 0;
		return charsToTokensUpper(k.length + 4) + sep;
	});

	// Entry-reduction loop
	let entriesToShow = entries.length;
	while (entriesToShow > 0) {
		const structCost = keyOverheads.slice(0, entriesToShow).reduce((a, b) => a + b, 0);
		const valueMins = entries.slice(0, entriesToShow).map(([, v]) => minValueCost(v));
		const remainderCost = entriesToShow < entries.length ? 2 : 0;
		if (structCost + valueMins.reduce((a, b) => a + b, 0) + remainderCost <= available) break;
		entriesToShow--;
	}

	if (entriesToShow === 0) return `{<${entries.length} keys>...}`;

	const totalKeyOverhead = keyOverheads.slice(0, entriesToShow).reduce((a, b) => a + b, 0);
	const remainderCost = entriesToShow < entries.length ? 2 : 0;
	const valueBudget = available - totalKeyOverhead - remainderCost;

	const measurements = entries.slice(0, entriesToShow).map(([, v]) => measureBounded(v, valueBudget));
	const allocations = allocateBudget(measurements, valueBudget);

	const ind = INDENT.repeat(depth + 1);
	const baseInd = INDENT.repeat(depth);

	let result = "{\n";
	for (let i = 0; i < entriesToShow; i++) {
		const [key, value] = entries[i];
		const rendered = renderValue(value, allocations[i], depth + 1);
		const comma = i < entriesToShow - 1 || entriesToShow < entries.length ? "," : "";
		result += `${ind}"${key}": ${indentSubsequentLines(rendered, depth + 1)}${comma}\n`;
	}
	if (entriesToShow < entries.length) {
		result += `${ind}...${entries.length - entriesToShow} more\n`;
	}
	result += `${baseInd}}`;
	return result;
}

// ---------------------------------------------------------------------------
// Internal: minimum value cost estimation
// ---------------------------------------------------------------------------

function minValueCost(value: unknown): number {
	if (value === null || value === undefined) return 1;
	if (typeof value === "boolean") return 1;
	if (typeof value === "number") return 1;
	if (typeof value === "string") {
		const fullCost = charsToTokensUpper(value.length + 2);
		return fullCost <= 3 ? fullCost : 3;
	}
	if (Array.isArray(value)) return value.length === 0 ? 1 : 2;
	const keys = Object.keys(value as Record<string, unknown>);
	return keys.length === 0 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Internal: full indented rendering (for values that fit within budget)
// ---------------------------------------------------------------------------

function renderFull2(value: unknown, depth: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return JSON.stringify(value);

	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const ind = INDENT.repeat(depth + 1);
		const baseInd = INDENT.repeat(depth);
		const items = value.map((v, i) => {
			const comma = i < value.length - 1 ? "," : "";
			return ind + indentSubsequentLines(renderFull2(v, depth + 1), depth + 1) + comma;
		});
		return `[\n${items.join("\n")}\n${baseInd}]`;
	}

	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
		if (entries.length === 0) return "{}";
		const ind = INDENT.repeat(depth + 1);
		const baseInd = INDENT.repeat(depth);
		const items = entries.map(([k, v], i) => {
			const comma = i < entries.length - 1 ? "," : "";
			return `${ind}"${k}": ${indentSubsequentLines(renderFull2(v, depth + 1), depth + 1)}${comma}`;
		});
		return `{\n${items.join("\n")}\n${baseInd}}`;
	}

	return String(value);
}

// ---------------------------------------------------------------------------
// Internal: homogeneous array check (local copy, independent of json/truncate)
// ---------------------------------------------------------------------------

function checkHomogeneous2(arr: unknown[]): boolean {
	if (arr.length < 2) return false;
	const sample = arr.slice(0, Math.min(5, arr.length));
	if (!sample.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
		return false;
	}
	const firstKeys = Object.keys(sample[0] as Record<string, unknown>)
		.sort()
		.join(",");
	return sample.every(
		(item) =>
			Object.keys(item as Record<string, unknown>)
				.sort()
				.join(",") === firstKeys,
	);
}

// ---------------------------------------------------------------------------
// Internal: indentation helper
// ---------------------------------------------------------------------------

function indentSubsequentLines(text: string, depth: number): string {
	const lines = text.split("\n");
	if (lines.length <= 1) return text;
	const ind = INDENT.repeat(depth);
	return (
		lines[0] +
		"\n" +
		lines
			.slice(1)
			.map((l) => ind + l)
			.join("\n")
	);
}
