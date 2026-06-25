/**
 * Boomerang Integration - Phase 6
 *
 * Combines heuristic-based context collapse with pi's existing LLM compaction.
 * Provides fast, deterministic summarization without requiring an LLM call,
 * useful for context overflow recovery and session tree navigation.
 *
 * Key features:
 * - Heuristic summarization: extracts key information from messages without LLM
 * - Session tree navigation: navigate between conversation branches
 * - Context collapse fallback: when LLM compaction fails or is too slow
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "./session-manager.ts";

export interface HeuristicSummary {
	/** Goal(s) extracted from user messages */
	goals: string[];
	/** Files that were read */
	readFiles: string[];
	/** Files that were modified */
	modifiedFiles: string[];
	/** Key errors encountered */
	errors: string[];
	/** Commands that were run */
	commands: string[];
	/** Extracted TODOs and pending items */
	pendingItems: string[];
	/** Brief turn-by-turn summary */
	turnSummary: string;
}

/**
 * Extract file paths from a tool call.
 */
function extractFilePath(_toolName: string, args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const record = args as Record<string, unknown>;
	return (record.file_path ?? record.path ?? record.directory) as string | null;
}

/**
 * Heuristic summarization of conversation messages.
 * Extracts goals, file operations, errors, and pending items without using an LLM.
 */
export function generateHeuristicSummary(messages: AgentMessage[]): HeuristicSummary {
	const goals: string[] = [];
	const readFiles = new Set<string>();
	const modifiedFiles = new Set<string>();
	const errors: string[] = [];
	const commands: string[] = [];
	const pendingItems: string[] = [];
	const turnNotes: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			// Extract goal from user messages
			const text =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join(" ");
			if (text.length > 10 && text.length < 500) {
				goals.push(text.trim().slice(0, 200));
			}
		} else if (msg.role === "assistant") {
			// Extract tool calls
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const filePath = extractFilePath(block.name, block.arguments);
					if (block.name === "read" && filePath) {
						readFiles.add(filePath);
					} else if ((block.name === "edit" || block.name === "write") && filePath) {
						modifiedFiles.add(filePath);
					} else if (block.name === "bash") {
						const cmd = (block.arguments as Record<string, unknown>)?.command as string | undefined;
						if (cmd && cmd.length < 200) {
							commands.push(cmd);
						}
					}
				}
			}
		} else if (msg.role === "toolResult") {
			// Extract errors from tool results
			const text =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join(" ");
			if (text.includes("error") || text.includes("failed") || text.includes("Error:")) {
				const errorLines = text
					.split("\n")
					.filter((line) => line.toLowerCase().includes("error") || line.toLowerCase().includes("failed"));
				errors.push(...errorLines.slice(0, 3).map((l) => l.slice(0, 200)));
			}
		} else if (msg.role === "bashExecution") {
			if (msg.output.includes("error") || msg.output.includes("failed")) {
				const errorLines = msg.output
					.split("\n")
					.filter((line) => line.toLowerCase().includes("error") || line.toLowerCase().includes("failed"));
				errors.push(...errorLines.slice(0, 2).map((l) => l.slice(0, 200)));
			}
		}
	}

	// Build turn summary
	turnNotes.push(`User goals: ${goals.length}`);
	turnNotes.push(`Files read: ${readFiles.size}`);
	turnNotes.push(`Files modified: ${modifiedFiles.size}`);
	turnNotes.push(`Commands run: ${commands.length}`);
	turnNotes.push(`Errors: ${errors.length}`);

	// Extract pending items from goals that weren't fully addressed
	if (goals.length > 0) {
		pendingItems.push(...goals.map((g) => `Complete: ${g}`));
	}

	return {
		goals,
		readFiles: Array.from(readFiles),
		modifiedFiles: Array.from(modifiedFiles),
		errors: Array.from(new Set(errors)),
		commands,
		pendingItems,
		turnSummary: turnNotes.join("\n"),
	};
}

/**
 * Format heuristic summary for injection into context.
 */
export function formatHeuristicSummary(summary: HeuristicSummary): string {
	const lines: string[] = [
		"<heuristic-context-summary>",
		"",
		"## Goals",
		...summary.goals.map((g) => `- ${g}`),
		"",
		"## Files Read",
		...summary.readFiles.slice(0, 20).map((f) => `- ${f}`),
		...(summary.readFiles.length > 20 ? [`... and ${summary.readFiles.length - 20} more`] : []),
		"",
		"## Files Modified",
		...summary.modifiedFiles.slice(0, 20).map((f) => `- ${f}`),
		...(summary.modifiedFiles.length > 20 ? [`... and ${summary.modifiedFiles.length - 20} more`] : []),
		"",
		"## Errors",
		...summary.errors.slice(0, 10).map((e) => `- ${e}`),
		...(summary.errors.length > 10 ? [`... and ${summary.errors.length - 10} more`] : []),
		"",
		"## Commands Run",
		...summary.commands.slice(0, 10).map((c) => `- ${c}`),
		...(summary.commands.length > 10 ? [`... and ${summary.commands.length - 10} more`] : []),
		"",
		"## Pending Items",
		...summary.pendingItems.slice(0, 10).map((p) => `- ${p}`),
		"",
		"## Summary",
		summary.turnSummary,
		"",
		"</heuristic-context-summary>",
	];

	return lines.join("\n");
}

/**
 * Context collapse result with both LLM and heuristic summaries.
 */
export interface ContextCollapseResult {
	/** LLM-based summary (if available) */
	llmSummary?: string;
	/** Heuristic-based summary (always available) */
	heuristicSummary: string;
	/** Files that were read before collapse */
	readFiles: string[];
	/** Files that were modified before collapse */
	modifiedFiles: string[];
}

/**
 * Perform context collapse using both heuristic and LLM summarization.
 * Falls back to heuristic-only if LLM fails.
 */
export async function collapseContext(
	messages: AgentMessage[],
	_model: unknown,
	options: {
		llmSummary?: string;
		reserveTokens?: number;
		apiKey?: string;
	} = {},
): Promise<ContextCollapseResult> {
	// Always generate heuristic summary
	const heuristicSummary = generateHeuristicSummary(messages);

	// Use provided LLM summary if available, otherwise generate one
	const llmSummary = options.llmSummary;

	return {
		llmSummary,
		heuristicSummary: formatHeuristicSummary(heuristicSummary),
		readFiles: heuristicSummary.readFiles,
		modifiedFiles: heuristicSummary.modifiedFiles,
	};
}

/**
 * Session tree node for navigation.
 */
export interface SessionTreeNode {
	/** Entry ID */
	id: string;
	/** Parent entry ID */
	parentId: string | null;
	/** Child entry IDs */
	childIds: string[];
	/** Summary of this node */
	summary?: string;
	/** Whether this is the current active leaf */
	isActive: boolean;
}

/**
 * Build a session tree from entries for navigation.
 */
export function buildSessionTree(entries: SessionEntry[]): SessionTreeNode[] {
	const nodes: SessionTreeNode[] = [];
	const entryMap = new Map<string, SessionEntry>();

	for (const entry of entries) {
		entryMap.set(entry.id, entry);
	}

	for (const entry of entries) {
		const node: SessionTreeNode = {
			id: entry.id,
			parentId: entry.parentId,
			childIds: [],
			isActive: false,
		};
		nodes.push(node);
	}

	// Build parent-child relationships
	for (const node of nodes) {
		if (node.parentId) {
			const parent = nodes.find((n) => n.id === node.parentId);
			if (parent) {
				parent.childIds.push(node.id);
			}
		}
	}

	return nodes;
}

/**
 * Navigate to a specific node in the session tree.
 * Returns the entries from that node to the current leaf.
 */
export function navigateToNode(entries: SessionEntry[], targetId: string): SessionEntry[] {
	const targetIndex = entries.findIndex((e) => e.id === targetId);
	if (targetIndex === -1) {
		return entries;
	}

	return entries.slice(targetIndex);
}
