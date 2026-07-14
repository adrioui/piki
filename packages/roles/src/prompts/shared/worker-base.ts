import { definePrompt, WORKER_BASE } from "../../prompt.ts";
import { ARCHITECT_PROMPT } from "../architect.ts";
import { ARTISAN_PROMPT } from "../artisan.ts";
import { CRITIC_PROMPT } from "../critic.ts";
import { ENGINEER_PROMPT } from "../engineer.ts";
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

export { WORKER_BASE };
