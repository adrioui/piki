/**
 * LLM-based goal verifier - Phase 1.
 *
 * Accepts goal text, transcript, tool results, and file changes,
 * then returns a JSON verdict: { verdict: "finished" | "incomplete", evidence: "..." }.
 *
 * Mirrors Command-Code's goal verification: the verifier uses an aux model
 * to assess whether the stated goal has been achieved. Includes timeout/retry
 * with a self-claim fallback (the agent's own claim is trusted if the verifier
 * is unavailable or times out).
 */

import type { Message } from "@piki/ai";
import type { AgentSessionServices } from "./agent-session-services.ts";
import { resolvePreferredAuxModel, runAuxModelText } from "./aux-model.ts";

export interface GoalVerifierInput {
	/** The goal text to verify. */
	goalText: string;
	/** Recent transcript messages (role + text). */
	transcript: Array<{ role: string; text: string }>;
	/** Tool results from the current turn. */
	toolResults: Array<{ toolName: string; result: unknown; isError: boolean }>;
	/** File changes made during the turn. */
	fileChanges: Array<{ path: string; action: "created" | "modified" | "deleted" }>;
	/** The agent's own claim about goal completion. */
	agentClaim?: "finished" | "incomplete";
}

export interface GoalVerdict {
	verdict: "finished" | "incomplete";
	evidence: string;
	/** Whether this verdict came from the LLM or a fallback. */
	source: "llm" | "fallback";
}

const VERIFIER_SYSTEM_PROMPT = [
	"You are a goal verifier for a coding agent.",
	"Assess whether the stated goal has been fully achieved based on the transcript, tool results, and file changes.",
	'Return a single JSON object with keys "verdict" (either "finished" or "incomplete") and "evidence" (a brief explanation).',
	'Be strict: only return "finished" if the evidence clearly shows the goal was met.',
	"Do not include any text outside the JSON object.",
].join("\n");

const MAX_RETRIES = 2;
const TIMEOUT_MS = 15_000;

function buildVerifierMessage(input: GoalVerifierInput): Message {
	const payload = {
		goal: input.goalText,
		agentClaim: input.agentClaim ?? "unknown",
		recentTranscript: input.transcript.slice(-12),
		toolResults: input.toolResults.slice(-20).map((r) => ({
			tool: r.toolName,
			error: r.isError,
			preview: typeof r.result === "string" ? r.result.slice(0, 500) : JSON.stringify(r.result).slice(0, 500),
		})),
		fileChanges: input.fileChanges.slice(-30),
	};

	return {
		role: "user",
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		timestamp: Date.now(),
	};
}

function parseVerdict(text: string): GoalVerdict | null {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[0]) as { verdict?: string; evidence?: string };
		if (parsed.verdict === "finished" || parsed.verdict === "incomplete") {
			return {
				verdict: parsed.verdict,
				evidence: typeof parsed.evidence === "string" ? parsed.evidence : "",
				source: "llm",
			};
		}
	} catch {
		// Fall through to null
	}
	return null;
}

/**
 * Verify whether a goal has been achieved using an LLM aux model.
 *
 * Uses the feature model `goalVerifier` if configured, otherwise falls back
 * to `resolvePreferredAuxModel`. Includes timeout/retry with a self-claim
 * fallback matching Command-Code's behavior.
 */
export async function verifyGoal(
	input: GoalVerifierInput,
	services: AgentSessionServices,
	preferredModel?: Parameters<typeof resolvePreferredAuxModel>[1],
): Promise<GoalVerdict> {
	const model = resolvePreferredAuxModel(services, preferredModel, "commandcode", "goalVerifier");
	if (!model) {
		return fallbackVerdict(input);
	}

	const message = buildVerifierMessage(input);

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
			try {
				const response = await runAuxModelText({
					services,
					model,
					systemPrompt: VERIFIER_SYSTEM_PROMPT,
					messages: [message],
					signal: controller.signal,
				});
				const verdict = parseVerdict(response);
				if (verdict) return verdict;
			} finally {
				clearTimeout(timer);
			}
		} catch {
			// Timeout or error - retry
		}
	}

	return fallbackVerdict(input);
}

/**
 * Fallback verdict: trust the agent's own claim if available,
 * otherwise default to "incomplete" (conservative).
 */
function fallbackVerdict(input: GoalVerifierInput): GoalVerdict {
	return {
		verdict: input.agentClaim === "finished" ? "finished" : "incomplete",
		evidence: "Verifier unavailable; falling back to agent's own claim.",
		source: "fallback",
	};
}
