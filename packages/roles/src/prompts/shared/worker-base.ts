import { definePrompt, WORKER_BASE } from "../../prompt.ts";
import { ARCHITECT_PROMPT } from "../architect.ts";
import { ARTISAN_PROMPT } from "../artisan.ts";
import { CRITIC_PROMPT } from "../critic.ts";
import { ENGINEER_PROMPT } from "../engineer.ts";
import { LEADER_PROMPT } from "../leader.ts";
import { OBSERVER_PROMPT } from "../observer.ts";
import { SCIENTIST_PROMPT } from "../scientist.ts";
import { SCOUT_PROMPT } from "../scout.ts";

/** Role-specific prompt texts (raw, with template vars). */
export const ROLE_PROMPTS: Record<string, string> = {
	scout: SCOUT_PROMPT,
	architect: ARCHITECT_PROMPT,
	engineer: ENGINEER_PROMPT,
	critic: CRITIC_PROMPT,
	scientist: SCIENTIST_PROMPT,
	artisan: ARTISAN_PROMPT,
	observer: OBSERVER_PROMPT,
};

/**
 * Returns the full system prompt for a worker role.
 * The role prompt already contains {{WORKER_BASE}} which is pre-compiled
 * by definePrompt into the full worker base text.
 */
export function getSystemPrompt(role: string, vars?: Record<string, string | number | boolean | undefined>): string {
	const rolePrompt = ROLE_PROMPTS[role] ?? "Complete the assigned task.";
	return definePrompt(rolePrompt).render(vars);
}

/**
 * Renders the full system prompt for a worker role, substituting the
 * `{{SKILLS_SECTION}}` and `{{THINKING_LIMIT}}` tokens left by the template
 * engine. piki's worker path must call this (rather than getSystemPrompt
 * without vars) so workers do not receive literal `{{...}}` placeholders.
 *
 * `skills` is a preformatted string (use the leader/worker skill formatter in
 * the consumer, e.g. formatSkillsForPrompt). `thinkingLimit` defaults to 20000
 * characters, matching event-core's per-role caps for non-scout roles.
 */
export function renderWorkerSystemPrompt(
	role: string,
	vars?: { skills?: string; thinkingLimit?: number; cwd?: string },
): string {
	const rolePrompt = ROLE_PROMPTS[role] ?? "Complete the assigned task.";
	const body = definePrompt(rolePrompt).render({
		SKILLS_SECTION: vars?.skills ?? "",
		THINKING_LIMIT: vars?.thinkingLimit ?? 20000,
	});
	if (!vars?.cwd) return body;
	const date = new Date().toISOString().slice(0, 10);
	return `${body}\nCurrent date: ${date}\nCurrent working directory: ${vars.cwd}`;
}

export { WORKER_BASE };

/**
 * Renders the leader's system prompt, substituting the template placeholders
 * left in LEADER_PROMPT so the leader never receives literal `{{...}}` tokens.
 *
 * - `{{CHECKPOINT_SECTION}}` → `checkpointSection` (caller passes the real
 *   checkpoint text when snapshots are enabled, otherwise empty string).
 * - `{{THINKING_SHARED}}` → the canonical shared thinking governance text,
 *   with `{{THINKING_LIMIT}}` resolved to `thinkingLimit`.
 * - `{{SKILLS_SECTION}}` → the preformatted skills string (`formatSkillsForPrompt`).
 *
 * `thinkingLimit` defaults to 20000, matching event-core's per-role cap for
 * the leader role.
 */
export function renderLeaderSystemPrompt(vars: {
	checkpointSection?: string;
	skills?: string;
	thinkingLimit?: number;
}): string {
	return definePrompt(LEADER_PROMPT).render({
		CHECKPOINT_SECTION: vars.checkpointSection ?? "",
		SKILLS_SECTION: vars.skills ?? "",
		THINKING_LIMIT: vars.thinkingLimit ?? 20000,
	});
}
