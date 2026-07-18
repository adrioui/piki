/**
 * Role-aware context and skill filtering helpers.
 *
 * Pure functions — no Effect dependencies. These helpers apply context lens
 * settings from RoleDef to filter skills, build role-specific context, and
 * determine tool visibility based on role configuration.
 */

import {
	type ContextLens,
	getRoleContextLens as getRoleContextLensFromEventCore,
	ROLE_DEFINITIONS,
	type RoleDef,
} from "@piki/event-core";
import type { Skill } from "@piki/skills";

// Re-export the event-core helper for convenience
export { getRoleContextLens } from "@piki/event-core";

/**
 * A role identifier that can be used for skill filtering.
 * Can be a RoleDef object or a role name string.
 */
export type SkillFilterRole = RoleDef | string;

/**
 * Resolve a SkillFilterRole to a RoleDef.
 * If a string is provided, looks up the role in ROLE_DEFINITIONS.
 * Returns undefined if the role name is not found.
 */
export function resolveRoleDef(role: SkillFilterRole): RoleDef | undefined {
	if (typeof role === "string") {
		return ROLE_DEFINITIONS[role];
	}
	return role;
}

/**
 * Filter skills based on role context lens visibility rules.
 *
 * - If `visibleSkills` is non-empty, only those skills are included.
 * - Skills in `excludedSkills` are always removed.
 * - If both arrays are empty, all skills are visible (default).
 * - Also respects skill-level `roles` / `exclude-roles` frontmatter.
 */
export function filterSkillsForRole(skills: Skill[], role: SkillFilterRole): Skill[] {
	const roleDef = resolveRoleDef(role);
	if (!roleDef) {
		// Unknown role: return all skills
		return skills;
	}
	const lens = getRoleContextLensFromEventCore(roleDef);
	const roleName = typeof role === "string" ? role : undefined;
	return filterSkillsWithLens(skills, lens, roleName);
}

/**
 * Filter skills using an explicit context lens (for cases where the lens
 * is already resolved).
 *
 * Applies both role-level lens settings (visibleSkills, excludedSkills)
 * and skill-level frontmatter constraints (roles, excludeRoles).
 */
export function filterSkillsWithLens(skills: Skill[], lens: ContextLens, roleName?: string): Skill[] {
	const { visibleSkills, excludedSkills } = lens;

	return skills.filter((skill) => {
		// Always exclude if in excludedSkills (role-level)
		if (excludedSkills.length > 0 && excludedSkills.includes(skill.name)) {
			return false;
		}

		// If visibleSkills is specified, only include those (role-level)
		if (visibleSkills.length > 0) {
			return visibleSkills.includes(skill.name);
		}

		// Check skill-level excludeRoles: if this role is excluded, hide the skill
		if (roleName && skill.excludeRoles.length > 0 && skill.excludeRoles.includes(roleName)) {
			return false;
		}

		// Check skill-level roles: if roles is non-empty and doesn't include this role, hide
		if (roleName && skill.roles.length > 0 && !skill.roles.includes(roleName)) {
			return false;
		}

		// Default: visible
		return true;
	});
}

/**
 * Build a role-specific context string from the available context components.
 *
 * Applies the role's context lens to control budgets and inclusion of
 * scratchpad/process context.
 */
export function buildRoleContext(input: {
	roleDef: RoleDef;
	sessionStart?: string;
	projectContext?: string;
	transcript?: string;
	scratchpad?: string;
	processContext?: string;
}): string {
	const lens = getRoleContextLensFromEventCore(input.roleDef);
	const parts: string[] = [];

	// Session start (always included, no budget)
	if (input.sessionStart) {
		parts.push(input.sessionStart);
	}

	// Project context (budget-limited)
	if (input.projectContext) {
		const budgeted = truncateToBudget(input.projectContext, lens.projectContextBudget);
		if (budgeted) {
			parts.push(budgeted);
		}
	}

	// Process context (conditional on lens)
	if (input.processContext && lens.includeProcess) {
		parts.push(input.processContext);
	}

	// Transcript (budget-limited)
	if (input.transcript) {
		const budgeted = truncateToBudget(input.transcript, lens.transcriptBudget);
		if (budgeted) {
			parts.push(budgeted);
		}
	}

	// Scratchpad (conditional on lens)
	if (input.scratchpad && lens.includeScratchpad) {
		parts.push(input.scratchpad);
	}

	return parts.join("\n\n");
}

/**
 * Truncate text to a character budget, keeping the most recent content.
 * Splits on paragraph boundaries when possible.
 */
function truncateToBudget(text: string, budget: number): string {
	if (text.length <= budget) return text;
	if (budget <= 0) return "";

	// Try to split on paragraph boundaries
	const paragraphs = text
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);

	if (paragraphs.length <= 1) {
		// Single block or no paragraphs: keep tail
		return text.slice(Math.max(0, text.length - budget));
	}

	// Keep first paragraph + most recent paragraphs that fit
	const first = paragraphs[0]!;
	const kept: string[] = [];
	let remaining = Math.max(0, budget - first.length - "\n\n".length);

	for (let i = paragraphs.length - 1; i > 0 && remaining > 0; i--) {
		const para = paragraphs[i]!;
		const cost = para.length + (kept.length > 0 ? "\n\n".length : 0);
		if (cost > remaining) {
			const slice = para.slice(Math.max(0, para.length - remaining));
			if (slice) kept.unshift(`[Earlier content truncated]\n${slice}`);
			break;
		}
		kept.unshift(para);
		remaining -= cost;
	}

	return [first, ...kept].join("\n\n");
}
