import { ROLE_DEFINITIONS } from "@piki/event-core";
import type { Skill } from "@piki/skills";
import { describe, expect, it } from "vitest";
import { filterSkillsForRole, filterSkillsWithLens, resolveRoleDef } from "../src/core/role-context.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

function createTestSkill(name: string, options?: { roles?: string[]; excludeRoles?: string[] }): Skill {
	return {
		name,
		description: `Description for ${name}`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "test" }),
		disableModelInvocation: false,
		roles: options?.roles ?? [],
		excludeRoles: options?.excludeRoles ?? [],
	};
}

describe("role-context", () => {
	describe("resolveRoleDef", () => {
		it("should resolve a string role name to RoleDef", () => {
			const result = resolveRoleDef("engineer");
			expect(result).toBe(ROLE_DEFINITIONS.engineer);
		});

		it("should return undefined for unknown role name", () => {
			const result = resolveRoleDef("unknown-role");
			expect(result).toBeUndefined();
		});

		it("should pass through a RoleDef object", () => {
			const roleDef = ROLE_DEFINITIONS.scout!;
			const result = resolveRoleDef(roleDef);
			expect(result).toBe(roleDef);
		});
	});

	describe("filterSkillsForRole", () => {
		const skills: Skill[] = [
			createTestSkill("clean-coder"),
			createTestSkill("librarian"),
			createTestSkill("browser-tools"),
		];

		it("should return all skills when role has empty visibility rules", () => {
			const result = filterSkillsForRole(skills, "engineer");
			expect(result).toHaveLength(3);
		});

		it("should exclude skills in excludedSkills", () => {
			const result = filterSkillsForRole(skills, "critic");
			// critic excludes "clean-coder"
			expect(result.map((s) => s.name)).not.toContain("clean-coder");
			expect(result).toHaveLength(2);
		});

		it("should return all skills for unknown role", () => {
			const result = filterSkillsForRole(skills, "unknown-role");
			expect(result).toHaveLength(3);
		});

		it("should accept a RoleDef object directly", () => {
			const roleDef = ROLE_DEFINITIONS.critic!;
			const result = filterSkillsForRole(skills, roleDef);
			expect(result.map((s) => s.name)).not.toContain("clean-coder");
		});
	});

	describe("filterSkillsWithLens", () => {
		const skills: Skill[] = [createTestSkill("alpha"), createTestSkill("beta"), createTestSkill("gamma")];

		it("should respect skill-level excludeRoles", () => {
			const skillsWithRoles = [
				createTestSkill("alpha", { excludeRoles: ["scout"] }),
				createTestSkill("beta"),
				createTestSkill("gamma", { excludeRoles: ["engineer"] }),
			];
			const result = filterSkillsWithLens(
				skillsWithRoles,
				{
					transcriptBudget: 50_000,
					projectContextBudget: 10_000,
					includeScratchpad: true,
					includeProcess: true,
					visibleSkills: [],
					excludedSkills: [],
				},
				"scout",
			);
			// alpha is excluded for scout, gamma is not excluded for scout
			expect(result.map((s) => s.name)).toEqual(["beta", "gamma"]);
		});

		it("should respect skill-level roles (allowlist)", () => {
			const skillsWithRoles = [
				createTestSkill("alpha", { roles: ["engineer"] }),
				createTestSkill("beta", { roles: [] }),
				createTestSkill("gamma", { roles: ["scout", "engineer"] }),
			];
			const result = filterSkillsWithLens(
				skillsWithRoles,
				{
					transcriptBudget: 50_000,
					projectContextBudget: 10_000,
					includeScratchpad: true,
					includeProcess: true,
					visibleSkills: [],
					excludedSkills: [],
				},
				"engineer",
			);
			// alpha is for engineer, beta has empty roles (visible to all), gamma is for scout+engineer
			expect(result.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
		});

		it("should hide skill when roles list doesn't include current role", () => {
			const skillsWithRoles = [
				createTestSkill("alpha", { roles: ["engineer"] }),
				createTestSkill("beta", { roles: [] }),
			];
			const result = filterSkillsWithLens(
				skillsWithRoles,
				{
					transcriptBudget: 50_000,
					projectContextBudget: 10_000,
					includeScratchpad: true,
					includeProcess: true,
					visibleSkills: [],
					excludedSkills: [],
				},
				"scout",
			);
			// alpha is only for engineer, scout can't see it; beta is visible to all
			expect(result.map((s) => s.name)).toEqual(["beta"]);
		});

		it("should check both lens and skill-level constraints", () => {
			const skillsWithRoles = [createTestSkill("alpha", { excludeRoles: ["scout"] }), createTestSkill("beta")];
			const result = filterSkillsWithLens(
				skillsWithRoles,
				{
					transcriptBudget: 50_000,
					projectContextBudget: 10_000,
					includeScratchpad: true,
					includeProcess: true,
					visibleSkills: [],
					excludedSkills: ["beta"],
				},
				"scout",
			);
			// alpha excluded by skill-level, beta excluded by lens
			expect(result).toHaveLength(0);
		});

		it("should return all skills when both arrays are empty", () => {
			const result = filterSkillsWithLens(skills, {
				transcriptBudget: 50_000,
				projectContextBudget: 10_000,
				includeScratchpad: true,
				includeProcess: true,
				visibleSkills: [],
				excludedSkills: [],
			});
			expect(result).toHaveLength(3);
		});

		it("should only include skills in visibleSkills", () => {
			const result = filterSkillsWithLens(skills, {
				transcriptBudget: 50_000,
				projectContextBudget: 10_000,
				includeScratchpad: true,
				includeProcess: true,
				visibleSkills: ["alpha", "gamma"],
				excludedSkills: [],
			});
			expect(result.map((s) => s.name)).toEqual(["alpha", "gamma"]);
		});

		it("should exclude skills in excludedSkills", () => {
			const result = filterSkillsWithLens(skills, {
				transcriptBudget: 50_000,
				projectContextBudget: 10_000,
				includeScratchpad: true,
				includeProcess: true,
				visibleSkills: [],
				excludedSkills: ["beta"],
			});
			expect(result.map((s) => s.name)).toEqual(["alpha", "gamma"]);
		});

		it("should apply both visibleSkills and excludedSkills", () => {
			const result = filterSkillsWithLens(skills, {
				transcriptBudget: 50_000,
				projectContextBudget: 10_000,
				includeScratchpad: true,
				includeProcess: true,
				visibleSkills: ["alpha", "beta", "gamma"],
				excludedSkills: ["beta"],
			});
			// excludedSkills takes precedence
			expect(result.map((s) => s.name)).toEqual(["alpha", "gamma"]);
		});

		it("should return empty when all skills are excluded", () => {
			const result = filterSkillsWithLens(skills, {
				transcriptBudget: 50_000,
				projectContextBudget: 10_000,
				includeScratchpad: true,
				includeProcess: true,
				visibleSkills: [],
				excludedSkills: ["alpha", "beta", "gamma"],
			});
			expect(result).toHaveLength(0);
		});
	});
});
