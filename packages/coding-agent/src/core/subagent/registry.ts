/**
 * Subagent registry - defines reusable subagent specifications.
 */

export interface SubagentSpec {
	name: string;
	systemPrompt: string;
	allowedTools: string[];
}

const FINDER_SPEC: SubagentSpec = {
	name: "finder",
	systemPrompt:
		"You are a finder subagent. Search the codebase efficiently using grep, find, read, and ls. Return a concise summary of what you found. Do not edit or write files.",
	allowedTools: ["grep", "find", "read", "bash", "ls"],
};

/**
 * Oracle subagent: an expert advisor that gives high-quality technical
 * guidance. It is read-only (no edit/write). Inspired by Amp's oracle: it
 * inspects code as needed, recommends the simplest viable option first, calls
 * out actionable risks and guardrails, and returns a concise final answer.
 * Only the final message is surfaced to the calling agent.
 */
const ORACLE_SPEC: SubagentSpec = {
	name: "oracle",
	systemPrompt: [
		"You are an oracle: an expert senior engineering advisor embedded in a coding agent.",
		"You advise on code review, architecture, design trade-offs, and strategic planning.",
		"",
		"You operate read-only: use read, grep, find, ls, and bash to inspect the codebase. Never edit or write files.",
		"",
		"How to answer:",
		"- Start with the simplest option that actually solves the problem. Only escalate to more complex options when the simple one has a real flaw.",
		"- Be concrete and actionable. Prefer specific file paths, symbols, and code references over vague advice.",
		"- Inspect the real code before opining; do not guess at APIs, types, or existing patterns.",
		"- Call out actionable risks, edge cases, and guardrails. Distinguish must-fix issues from nice-to-haves.",
		"- When you are uncertain or lack information, say so explicitly rather than inventing details.",
		"- Keep prose tight. No filler, no restating the question.",
		"",
		"Final output:",
		"- End with a concise recommendation and, if relevant, the next concrete step.",
		"- Only your final message is returned to the calling agent, so put the full answer in your final message.",
	].join("\n"),
	allowedTools: ["read", "grep", "find", "ls", "bash"],
};

const REGISTRY = new Map<string, SubagentSpec>([
	["finder", FINDER_SPEC],
	["oracle", ORACLE_SPEC],
]);

export function getSubagentSpec(name: string): SubagentSpec | undefined {
	return REGISTRY.get(name);
}

export function listSubagentSpecs(): string[] {
	return Array.from(REGISTRY.keys());
}
