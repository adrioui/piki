/**
 * Subagent registry - defines reusable subagent specifications.
 *
 * Inspired by Amp's R8 specialist registry which assigns each specialist a
 * fixed model optimized for cost/capability trade-offs. The `model` field
 * specifies which model to use for this subagent:
 * - "inherit": use the parent agent's model (default, for coding work)
 * - "fastest-available": pick from known cheap/fast model IDs if configured
 *
 * Amp's pattern:
 * - Finder → cheapest model (Haiku) for simple file search
 * - Oracle → mid-tier reasoning model for advisory work
 * - Task subagent → inherits parent model for actual coding work
 */

export interface SubagentSpec {
	name: string;
	systemPrompt: string;
	allowedTools: string[];
	/**
	 * Model selection strategy. When omitted, inherits the parent model.
	 * "fastest-available" picks from known cheap/fast model IDs.
	 */
	model?: "inherit" | "fastest-available";
}

/** Known cheap/fast model IDs, ordered by preference (cheapest first). */
const FAST_MODEL_IDS = [
	"claude-haiku-4-5-20251001",
	"claude-haiku",
	"gpt-4o-mini",
	"gpt-nano",
	"gemini-2.0-flash",
	"gemini-2.5-flash",
];

/**
 * Resolve the actual model for a subagent given its spec and the parent model.
 * If the spec says "fastest-available", picks the first known cheap model that
 * matches the parent model's provider (to avoid auth issues).
 * Falls back to parent model if no fast model is available.
 */
export function resolveSubagentModel(
	spec: SubagentSpec,
	parentModel: { provider: string; id: string } | undefined,
): { provider: string; id: string } | undefined {
	if (!parentModel) return undefined;

	const modelStrategy = spec.model ?? "inherit";
	if (modelStrategy === "inherit") {
		return parentModel;
	}

	// fastest-available: pick a known cheap model from the same provider
	if (modelStrategy === "fastest-available") {
		for (const fastId of FAST_MODEL_IDS) {
			// Try to find a fast model from the same provider
			if (parentModel.id.toLowerCase().includes(fastId.toLowerCase().split("-")[0])) {
				return { provider: parentModel.provider, id: fastId };
			}
		}
		// Fall back to parent if no fast model from same provider
		return parentModel;
	}

	return parentModel;
}

const FINDER_SPEC: SubagentSpec = {
	name: "finder",
	systemPrompt:
		"You are a finder subagent. Search the codebase efficiently using grep, find, read, and ls. Return a concise summary of what you found. Do not edit or write files.",
	allowedTools: ["grep", "find", "read", "bash", "ls"],
	// Amp's finder uses Haiku (cheapest) — we use fastest-available to pick
	// the cheapest model the user has configured.
	model: "fastest-available",
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
	// Oracle needs reasoning capability — inherit parent model so it gets
	// whatever model the user has chosen for its reasoning strength.
	model: "inherit",
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
