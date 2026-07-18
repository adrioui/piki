/**
 * S7 Scientist re-audit probes — prompts / roles / skills / extensions.
 *
 * These probes pin observable behavior of piki's leader/worker system-prompt
 * composition against Magnitude alpha22's `buildSystemPrompt`
 * (magnitude-alpha22.embedded.js:113371). They are deterministic and run with
 * the package-local vitest config (no e2e, no network).
 *
 * Finding context (see scratchpad/reports/sci-s7-prompts.md):
 *  - mag injects `{{SKILLS_SECTION}}` (the skill reference list) INSIDE the
 *    role prompt body, immediately after the `# Skills` heading / before
 *    `# Thinking`. Only a headless section is appended after the body.
 *  - piki now mirrors mag: the leader body's `{{SKILLS_SECTION}}` placeholder
 *    is filled inside the body (after `# Skills`), matching mag placement.
 *    The tail no longer re-injects the skill list (single injection).
 *  - Skill activation now renders labeled `## Shared`/`## Lead`/`## Worker`/
 *    `## Handoff` sections from the parsed `sections` rather than leaking raw
 *    `<!-- @shared -->` markers.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { renderLeaderSystemPrompt, renderWorkerSystemPrompt } from "@piki/roles";
import { formatSkillsForPrompt, type Skill } from "@piki/skills";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt, buildSystemPromptTail } from "../src/core/system-prompt.ts";
import { createSkillTool } from "../src/core/tools/skill.ts";

function makeSkill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "test" }),
		disableModelInvocation: false,
		roles: [],
		excludeRoles: [],
	};
}

/** Replicates AgentSession._rebuildSystemPrompt's leader composition. */
function buildLeaderPrompt(): string {
	const skills = [makeSkill("docx", "Create DOCX documents")];
	const body = renderLeaderSystemPrompt({
		thinkingLimit: 20000,
		skills: formatSkillsForPrompt(skills),
	});
	const tail = buildSystemPromptTail({
		cwd: process.cwd(),
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
		modelName: "Claude Sonnet",
	});
	return buildSystemPrompt({
		cwd: process.cwd(),
		customPrompt: body,
		appendSystemPrompt: tail,
		skills,
		contextFiles: [],
		skipSkillsInTail: true,
	});
}

const SKILL_MARKED_DIR = "/tmp/skill-marked";
const SKILL_MARKED_FILE = `${SKILL_MARKED_DIR}/SKILL.md`;
const SKILL_MARKED_BODY = `---
name: marked
description: Marked skill
---

# Marked skill

<!-- @shared -->
shared text

<!-- @worker -->
worker text
`;

beforeAll(() => {
	mkdirSync(SKILL_MARKED_DIR, { recursive: true });
	writeFileSync(SKILL_MARKED_FILE, SKILL_MARKED_BODY, "utf8");
});

afterAll(() => {
	rmSync(SKILL_MARKED_DIR, { recursive: true, force: true });
});

describe("S7: leader skill-section placement vs mag", () => {
	test("MATCH: leader skills render inside the body # Skills section (not only at the tail)", () => {
		const prompt = buildLeaderPrompt();
		const skillsIdx = prompt.indexOf("<available_skills>");
		const tailSentinelIdx = prompt.indexOf("Current working directory");
		expect(skillsIdx).toBeGreaterThan(-1);
		// The skill list sits inside the leader body (before the tail's
		// working-directory sentinel), matching mag's in-body placement.
		// (In the leader template `# Skills` follows `# Thinking`, so the list
		// appears after `# Thinking` but still within the body, before the tail.)
		expect(skillsIdx).toBeLessThan(tailSentinelIdx);
	});

	test("leader prompt contains exactly one available-skills block", () => {
		const prompt = buildLeaderPrompt();
		expect(prompt.match(/<available_skills>/g)).toHaveLength(1);
		// No literal placeholder remains in the rendered body.
		expect(prompt).not.toContain("{{SKILLS_SECTION}}");
	});
});

describe("S7: worker skill-section placement vs mag", () => {
	test("MATCH: worker skills are injected inside the body (filled {{SKILLS_SECTION}} placeholder)", () => {
		const prompt = renderWorkerSystemPrompt("engineer", {
			skills: "<available_skills><skill>docx</skill></available_skills>",
			thinkingLimit: 20000,
		});
		const skillsIdx = prompt.indexOf("<available_skills>");
		const thinkingIdx = prompt.indexOf("# Thinking");
		// mag's worker base also ends with `## Skills` + SKILLS_SECTION after the
		// `# Thinking`/scratchpad sections, so skills-late-inside-body matches.
		expect(skillsIdx).toBeGreaterThan(-1);
		expect(thinkingIdx).toBeGreaterThan(-1);
		expect(skillsIdx).toBeGreaterThan(thinkingIdx);
		// The `## Skills` heading precedes the injected list within the body.
		expect(prompt.indexOf("## Skills")).toBeLessThan(skillsIdx);
		// No literal placeholder remains.
		expect(prompt).not.toContain("{{SKILLS_SECTION}}");
	});
});

describe("S7: skill activation output format vs mag", () => {
	test("renders parsed role sections without leaking raw markers", async () => {
		const skill: Skill = {
			...makeSkill("marked", "Marked skill"),
			filePath: SKILL_MARKED_FILE,
			baseDir: SKILL_MARKED_DIR,
			sections: [
				{ name: "shared", content: "shared text" },
				{ name: "worker", content: "worker text" },
			],
		};
		const tool = createSkillTool({ getSkills: () => [skill] });
		const root = await tool.execute("test-call", { name: "marked" });
		const text = root.content[0]?.type === "text" ? root.content[0].text : "";
		expect(text).toContain("## Shared");
		expect(text).toContain("shared text");
		expect(text).toContain("## Worker");
		expect(text).toContain("worker text");
		expect(text).not.toContain("<!-- @shared -->");
		expect(text).not.toContain("<!-- @worker -->");
	});
});
