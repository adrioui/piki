/**
 * Budget-aware rendering of folder tree nodes.
 */

import { CHARS_PER_TOKEN_UPPER } from "../../constants.ts";
import { allocateBudget, charsToTokensUpper } from "../budget.ts";
import type { FolderTreeNode } from "./tree.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REMAINDER_COST = 5;

// ---------------------------------------------------------------------------
// Token annotation helpers
// ---------------------------------------------------------------------------

function formatTokenAnnotation(totalBytes: number): string {
	if (totalBytes === 0) return "";
	const tokens = Math.round(totalBytes / CHARS_PER_TOKEN_UPPER);
	if (tokens < 1000) return ` (~${tokens} tok)`;
	return ` (~${Math.round(tokens / 1000)}k tok)`;
}

function folderLineCost(depth: number, name: string, totalBytes: number = 0): number {
	const annotation = formatTokenAnnotation(totalBytes);
	return charsToTokensUpper(depth * 2 + name.length + 1 + annotation.length + 1);
}

function folderIndent(depth: number): string {
	return "  ".repeat(depth);
}

function folderLine(name: string, depth: number, totalBytes: number = 0): string {
	return `${folderIndent(depth) + name}/${formatTokenAnnotation(totalBytes)}\n`;
}

// ---------------------------------------------------------------------------
// Sorting and measurement
// ---------------------------------------------------------------------------

function sortByRecency(folders: FolderTreeNode[]): FolderTreeNode[] {
	return [...folders].sort((a, b) => b.lastModified - a.lastModified);
}

function measureSubtreeCost(
	children: FolderTreeNode[],
	depth: number,
	cap: number,
): { size: number; exceeded: boolean } {
	let total = 0;
	for (const child of children) {
		total += folderLineCost(depth, child.name, child.totalBytes);
		if (total > cap) return { size: cap, exceeded: true };
		const sub = measureSubtreeCost(child.children, depth + 1, cap - total);
		total += sub.size;
		if (sub.exceeded) return { size: cap, exceeded: true };
	}
	return { size: total, exceeded: false };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPartialSiblings(children: FolderTreeNode[], budget: number, depth: number): string {
	let availableForNames = budget - REMAINDER_COST;
	let result = "";
	let shown = 0;

	for (const child of children) {
		const cost = folderLineCost(depth, child.name, child.totalBytes);
		if (cost > availableForNames) break;
		result += folderLine(child.name, depth, child.totalBytes);
		availableForNames -= cost;
		shown++;
	}

	if (shown < children.length) {
		const remaining = children.length - shown;
		if (shown === 0) {
			result += `${folderIndent(depth)}... (${remaining} ${remaining === 1 ? "subfolder" : "subfolders"})\n`;
		} else {
			result += `${folderIndent(depth)}... (${remaining} more)\n`;
		}
	}

	return result;
}

function renderChildrenWithBudget(children: FolderTreeNode[], budget: number, depth: number): string {
	if (children.length === 0 || budget <= 0) return "";

	const sortedChildren = sortByRecency(children);
	const lineCosts = sortedChildren.map((c) => folderLineCost(depth, c.name, c.totalBytes));
	const totalLineCost = lineCosts.reduce((a, b) => a + b, 0);

	// If just the lines exceed budget, render partial siblings
	if (totalLineCost > budget) {
		return renderPartialSiblings(sortedChildren, budget, depth);
	}

	const subtreeBudget = budget - totalLineCost;

	// Lines fit but no budget left for children
	if (subtreeBudget <= 0) {
		return sortedChildren.map((c) => folderLine(c.name, depth, c.totalBytes)).join("");
	}

	// Measure subtrees and allocate budget
	const measurements = sortedChildren.map((c) => measureSubtreeCost(c.children, depth + 1, subtreeBudget));
	const allocations = allocateBudget(measurements, subtreeBudget);

	let result = "";
	for (let i = 0; i < sortedChildren.length; i++) {
		const child = sortedChildren[i];
		result += folderLine(child.name, depth, child.totalBytes);

		if (child.children.length === 0) continue;

		if (allocations[i] > 0) {
			result += renderChildrenWithBudget(child.children, allocations[i], depth + 1);
		} else {
			const count = child.children.length;
			result += `${folderIndent(depth + 1)}... (${count} ${count === 1 ? "subfolder" : "subfolders"})\n`;
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render a folder tree as an indented string, truncated to a token budget.
 *
 * @param rootChildren - Top-level folder tree nodes.
 * @param budgetTokens - Maximum token budget (default 400).
 */
export function truncateFolderTree(rootChildren: FolderTreeNode[], budgetTokens: number = 400): string {
	if (rootChildren.length === 0) return "";
	return renderChildrenWithBudget(rootChildren, budgetTokens, 0).trimEnd();
}
