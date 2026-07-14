/**
 * XML body value truncation.
 *
 * Three tightly coupled functions that bridge XML body rendering with
 * the JSON truncation and measurement layers.
 */

import { CHARS_PER_TOKEN_UPPER } from "../constants.ts";
import { allocateBudget, charsToTokensUpper } from "./budget.ts";
import { measureBounded } from "./json/measure.ts";
import { truncate } from "./json/truncate.ts";

/**
 * Truncate a plain string for use inside an XML body, preserving the
 * `...` suffix convention.
 */
export function truncateXmlBodyString(value: string, budgetTokens: number): string {
	if (charsToTokensUpper(value.length) <= budgetTokens) return value;
	if (budgetTokens < 1) return "...";
	const maxOutputChars = Math.floor(budgetTokens * CHARS_PER_TOKEN_UPPER);
	const availableForContent = maxOutputChars - 3; // reserve for "..."
	if (availableForContent <= 0) return "...";
	return `${value.slice(0, availableForContent)}...`;
}

/**
 * Render a single value for an XML body. Strings go through the
 * XML-specific truncation; everything else delegates to recursive
 * JSON truncation.
 */
export function renderXmlBodyValue(value: unknown, budgetTokens: number): string {
	if (typeof value === "string") return truncateXmlBodyString(value, budgetTokens);
	return truncate(value, budgetTokens);
}

/**
 * Render multiple values for an XML body, distributing the total token
 * budget across them via measurement and allocation.
 */
export function renderXmlBodyValues(values: unknown[], totalBudgetTokens: number): string[] {
	const measurements = values.map((value) => measureBounded(value, totalBudgetTokens));
	const allocations = allocateBudget(measurements, totalBudgetTokens);
	return values.map((value, index) => renderXmlBodyValue(value, allocations[index] ?? 0));
}
