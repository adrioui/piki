/**
 * Recursive JSON truncation to a token budget.
 *
 * All functions in this module are tightly coupled through recursive
 * references and must stay together as one atomic unit.
 */

import { CHARS_PER_TOKEN_UPPER } from "../../constants.ts";
import { allocateBudget, charsToTokensUpper } from "../budget.ts";
import { jsonEscapedCharLen, measureBounded } from "./measure.ts";

// ---------------------------------------------------------------------------
// Shared token cost constants
// ---------------------------------------------------------------------------

export const TOKEN_COSTS = {
	ELLIPSIS: 1,
	ARRAY_BRACKETS: 1,
	OBJECT_BRACES: 1,
	SEPARATOR: 1,
	COLON: 1,
	ARRAY_PLACEHOLDER: 2,
	OBJECT_PLACEHOLDER: 2,
	REMAINDER_MAX: 7,
} as const;

// ---------------------------------------------------------------------------
// Cost estimation helpers
// ---------------------------------------------------------------------------

export function flatMinCost(value: unknown): number {
	if (value === null || value === undefined) return charsToTokensUpper(4);
	if (typeof value === "boolean") return charsToTokensUpper(value ? 4 : 5);
	if (typeof value === "number") return charsToTokensUpper(String(value).length);
	if (typeof value === "string") {
		const fullCost = charsToTokensUpper(value.length + 2);
		if (fullCost <= 3) return fullCost;
		return 3;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return TOKEN_COSTS.ARRAY_BRACKETS;
		return charsToTokensUpper(`[...${value.length} items]`.length);
	}
	const keys = Object.keys(value);
	if (keys.length === 0) return TOKEN_COSTS.OBJECT_BRACES;
	return charsToTokensUpper(`{...(${keys.length} keys)}`.length);
}

export function minMeaningfulCost(value: unknown): number {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return flatMinCost(value);
	}
	const entries = Object.entries(value);
	if (entries.length === 0) return TOKEN_COSTS.OBJECT_BRACES;
	const previewCount = Math.min(3, entries.length);
	let cost = TOKEN_COSTS.OBJECT_BRACES;
	for (let i = 0; i < previewCount; i++) {
		const [key, val] = entries[i];
		if (i > 0) cost += TOKEN_COSTS.SEPARATOR;
		cost += charsToTokensUpper(key.length) + TOKEN_COSTS.COLON;
		cost += flatMinCost(val);
	}
	if (previewCount < entries.length) {
		cost += TOKEN_COSTS.REMAINDER_MAX;
	}
	return cost;
}

// ---------------------------------------------------------------------------
// Full rendering (non-recursive, for small-enough values)
// ---------------------------------------------------------------------------

export function renderFull(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((v) => renderFull(v)).join(", ")}]`;
	}
	const entries = Object.entries(value).filter(([, v]) => v !== undefined);
	return `{${entries.map(([k, v]) => `${k}: ${renderFull(v)}`).join(", ")}}`;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function truncate(value: unknown, budgetTokens: number): string {
	// Enforce minimum placeholder costs for non-empty containers
	if (Array.isArray(value) && value.length > 0) {
		budgetTokens = Math.max(budgetTokens, TOKEN_COSTS.ARRAY_PLACEHOLDER);
	} else if (typeof value === "object" && value !== null && Object.keys(value).length > 0) {
		budgetTokens = Math.max(budgetTokens, TOKEN_COSTS.OBJECT_PLACEHOLDER);
	}

	if (budgetTokens < TOKEN_COSTS.ELLIPSIS) return "...";

	if (value === undefined) return budgetTokens >= 2 ? "undefined" : "...";
	if (value === null) return budgetTokens >= 2 ? "null" : "...";

	if (typeof value === "boolean") {
		const s = String(value);
		return charsToTokensUpper(s.length) <= budgetTokens ? s : "...";
	}

	if (typeof value === "number") {
		const s = String(value);
		return charsToTokensUpper(s.length) <= budgetTokens ? s : "...";
	}

	if (typeof value === "string") return truncateString(value, budgetTokens);
	if (Array.isArray(value)) return truncateArray(value, budgetTokens);
	if (typeof value === "object") return truncateObject(value as Record<string, unknown>, budgetTokens);

	return "...";
}

// ---------------------------------------------------------------------------
// String truncation (escape-aware, character-level)
// ---------------------------------------------------------------------------

export function truncateString(s: string, budgetTokens: number): string {
	const full = JSON.stringify(s);
	if (charsToTokensUpper(full.length) <= budgetTokens) return full;

	if (budgetTokens < 3) return "...";

	const maxOutputChars = Math.floor(budgetTokens * CHARS_PER_TOKEN_UPPER);
	const availableForContent = maxOutputChars - 5; // "..."
	if (availableForContent <= 0) return "...";

	let escapedLen = 0;
	let rawEnd = 0;
	for (let i = 0; i < s.length; i++) {
		const charLen = jsonEscapedCharLen(s.charCodeAt(i));
		if (escapedLen + charLen > availableForContent) break;
		escapedLen += charLen;
		rawEnd = i + 1;
	}

	if (rawEnd === 0) return "...";

	const truncated = s.slice(0, rawEnd);
	return `${JSON.stringify(truncated).slice(0, -1)}..."`;
}

// ---------------------------------------------------------------------------
// Array truncation
// ---------------------------------------------------------------------------

export function truncateArray(arr: unknown[], budgetTokens: number): string {
	if (arr.length === 0) return "[]";

	if (!measureBounded(arr, budgetTokens).exceeded) {
		return renderFull(arr);
	}

	const countIndicator = `[...${arr.length} items]`;
	if (budgetTokens < TOKEN_COSTS.ARRAY_PLACEHOLDER) return "[...]";

	const availableTokens = budgetTokens - TOKEN_COSTS.ARRAY_BRACKETS - TOKEN_COSTS.REMAINDER_MAX;

	if (availableTokens < TOKEN_COSTS.ELLIPSIS) {
		return charsToTokensUpper(countIndicator.length) <= budgetTokens ? countIndicator : "[...]";
	}

	if (checkHomogeneous(arr)) {
		return truncateHomogeneousArray(arr, availableTokens);
	}
	return truncateHeterogeneousArray(arr, availableTokens);
}

export function checkHomogeneous(arr: unknown[]): boolean {
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

export function truncateHomogeneousArray(arr: unknown[], availableTokens: number): string {
	const MIN_TOKENS_PER_ITEM = 15;
	const itemCount = Math.min(3, arr.length, Math.max(1, Math.floor(availableTokens / MIN_TOKENS_PER_ITEM)));
	const separatorTokens = (itemCount - 1) * TOKEN_COSTS.SEPARATOR;
	const tokensForItems = availableTokens - separatorTokens;

	const measurements = arr.slice(0, itemCount).map((v) => measureBounded(v, tokensForItems));
	const allocations = allocateBudget(measurements, tokensForItems);

	const parts: string[] = [];
	for (let i = 0; i < itemCount; i++) {
		parts.push(truncate(arr[i], allocations[i]));
	}

	let result = `[${parts.join(", ")}`;
	if (itemCount < arr.length) {
		result += `, ...${arr.length - itemCount} more`;
	}
	result += "]";
	return result;
}

export function truncateHeterogeneousArray(arr: unknown[], availableTokens: number): string {
	const sampleSize = Math.min(5, arr.length);
	let totalMinMeaningful = 0;
	for (let i = 0; i < sampleSize; i++) {
		totalMinMeaningful += minMeaningfulCost(arr[i]);
	}
	const avgMinMeaningful = totalMinMeaningful / sampleSize;
	const targetPerItem = Math.max(15, Math.ceil(avgMinMeaningful * 3));
	const itemCount = Math.max(1, Math.min(arr.length, Math.floor(availableTokens / targetPerItem)));

	const separatorTokens = (itemCount - 1) * TOKEN_COSTS.SEPARATOR;
	const tokensForItems = availableTokens - separatorTokens;

	const measurements = arr.slice(0, itemCount).map((v) => measureBounded(v, tokensForItems));
	const allocations = allocateBudget(measurements, tokensForItems);

	const parts: string[] = [];
	for (let i = 0; i < itemCount; i++) {
		parts.push(truncate(arr[i], allocations[i]));
	}

	let result = `[${parts.join(", ")}`;
	if (itemCount < arr.length) {
		result += `, ...${arr.length - itemCount} more`;
	}
	result += "]";
	return result;
}

// ---------------------------------------------------------------------------
// Object truncation
// ---------------------------------------------------------------------------

export function truncateObject(obj: Record<string, unknown>, budgetTokens: number): string {
	const entries = Object.entries(obj);
	if (entries.length === 0) return "{}";

	if (!measureBounded(obj, budgetTokens).exceeded) {
		return renderFull(obj);
	}

	if (budgetTokens < TOKEN_COSTS.OBJECT_PLACEHOLDER) return "{...}";

	const availableTokens = budgetTokens - TOKEN_COSTS.OBJECT_BRACES;

	const keyOverheads = entries.map(([k], i) => {
		const sepTokens = i > 0 ? TOKEN_COSTS.SEPARATOR : 0;
		return sepTokens + charsToTokensUpper(k.length) + TOKEN_COSTS.COLON;
	});

	const meaningfulCosts = entries.map(([, v]) => minMeaningfulCost(v));

	// Entry-reduction loop
	let entriesToShow = entries.length;
	while (entriesToShow > 0) {
		const structuralCost = keyOverheads.slice(0, entriesToShow).reduce((a, b) => a + b, 0);
		const meaningfulTotal = meaningfulCosts.slice(0, entriesToShow).reduce((a, b) => a + b, 0);
		const remainderCost = entriesToShow < entries.length ? TOKEN_COSTS.REMAINDER_MAX : 0;
		if (structuralCost + meaningfulTotal + remainderCost <= availableTokens) {
			break;
		}
		entriesToShow--;
	}

	if (entriesToShow === 0) {
		const countStr = `{...(${entries.length} keys)}`;
		return charsToTokensUpper(countStr.length) <= budgetTokens ? countStr : "{...}";
	}

	// Per-value measurement + allocation
	const totalKeyOverhead = keyOverheads.slice(0, entriesToShow).reduce((a, b) => a + b, 0);
	const remainderCost = entriesToShow < entries.length ? TOKEN_COSTS.REMAINDER_MAX : 0;
	const valuesTokens = Math.max(0, availableTokens - totalKeyOverhead - remainderCost);

	const measurements = entries.slice(0, entriesToShow).map(([, v]) => measureBounded(v, valuesTokens));
	const allocations = allocateBudget(measurements, valuesTokens);

	let result = "{";
	let shown = 0;
	for (let i = 0; i < entriesToShow; i++) {
		const [key, value] = entries[i];
		const allocation = allocations[i];
		const sep = shown > 0 ? ", " : "";
		const valStr = truncate(value, allocation);
		result += `${sep}${key}: ${valStr}`;
		shown++;
	}
	if (shown < entries.length) {
		result += `, ...${entries.length - shown} more`;
	}
	result += "}";
	return result;
}
