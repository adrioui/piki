/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@piki/agent-core";
import type { ImageContent, Message, TextContent } from "@piki/ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

// Marker injected into the model-facing conversation at each turn boundary.
// Matches the format the LEADER_PROMPT advertises and that
// snapshot.ts#isBoundaryTimestamp parses for checkpoint `since` addressing.
export const TURN_BOUNDARY_PREFIX = "--- ";
export const TURN_BOUNDARY_SUFFIX = " ---";

// Pre-compiled test for an already-injected separator (idempotency guard).
const TURN_BOUNDARY_RE = /^--- \d{1,2}:\d{2}:\d{2} ---$/;

/** Format a turn-boundary separator from an epoch-ms timestamp (local HH:MM:SS). */
export function formatTurnBoundary(timestamp: number): string {
	const d = new Date(timestamp);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${TURN_BOUNDARY_PREFIX}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${TURN_BOUNDARY_SUFFIX}`;
}

function messageText(msg: Message): string {
	const c = msg.content;
	if (typeof c === "string") return c;
	return c.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/**
 * Inject `--- HH:MM:SS ---` turn-boundary separators into the model-facing
 * conversation. A separator is inserted immediately before each `user` message
 * that begins a turn (carries a timestamp) unless:
 *   - the message is a compaction/branch summary (detected by content prefix), or
 *   - the preceding message is already a separator (idempotency guard).
 *
 * Injection happens only in `convertToLlm` (throwaway per-call output), so the
 * canonical `AgentMessage[]` stays clean and re-serialization across session
 * reload cannot accumulate duplicate separators.
 */
export function injectTurnBoundarySeparators(messages: Message[]): Message[] {
	const out: Message[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const text = messageText(msg);
			const isSeparator = TURN_BOUNDARY_RE.test(text);
			const isSummary = text.startsWith(COMPACTION_SUMMARY_PREFIX) || text.startsWith(BRANCH_SUMMARY_PREFIX);
			const prev = out[out.length - 1];
			const prevIsSeparator = prev !== undefined && prev.role === "user" && TURN_BOUNDARY_RE.test(messageText(prev));
			if (!isSeparator && !isSummary && msg.timestamp !== undefined && !prevIsSeparator) {
				out.push({
					role: "user",
					content: [{ type: "text", text: formatTurnBoundary(msg.timestamp) }],
					timestamp: msg.timestamp,
				});
			}
		}
		out.push(msg);
	}
	return out;
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@piki/agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const result = messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
	return injectTurnBoundarySeparators(result);
}
