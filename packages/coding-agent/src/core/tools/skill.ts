import { readFile } from "node:fs/promises";
import type { AgentTool } from "@piki/agent-core";
import type { Skill, SkillSection } from "@piki/skills";
import { type Static, Type } from "typebox";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const skillSchema = Type.Object({
	name: Type.String({ description: 'Skill name to activate (e.g., "research", "plan", "implement")' }),
});

export type SkillToolInput = Static<typeof skillSchema>;

export interface SkillToolDetails {
	skillName: string;
	skillPath: string;
	baseDir: string;
}

export interface SkillToolOptions {
	getSkills?: () => readonly Skill[];
	onSkillActivated?: (details: SkillToolDetails) => void;
}

function formatSkillBlock(skill: Skill, body: string): string {
	const markerPattern = /<!--\s*@(shared|lead|worker|handoff)\s*-->/i;
	const sections = markerPattern.test(body) ? (skill.sections ?? []) : [];
	const renderedBody =
		sections.length > 0
			? sections
					.map(
						(section: SkillSection) =>
							`## ${section.name[0]!.toUpperCase()}${section.name.slice(1)}\n\n${section.content}`,
					)
					.join("\n\n")
			: body;
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${renderedBody}\n</skill>`;
}

export function createSkillToolDefinition(
	options: SkillToolOptions = {},
): ToolDefinition<typeof skillSchema, SkillToolDetails> {
	return {
		name: "skill",
		label: "skill",
		description:
			'Activate a skill by name to load its full methodology into context. Returns the skill content — observe the result before acting on the skill\'s guidance. Skills provide detailed methodologies for specific types of work (e.g., "research", "plan", "implement").',
		parameters: skillSchema,
		async execute(_toolCallId, params: SkillToolInput) {
			const skill = options.getSkills?.().find((candidate) => candidate.name === params.name);
			if (!skill) {
				throw new Error(`Unknown skill: ${params.name}`);
			}
			const content = await readFile(skill.filePath, "utf8");
			const body = stripFrontmatter(content).trim();
			const details: SkillToolDetails = {
				skillName: skill.name,
				skillPath: skill.filePath,
				baseDir: skill.baseDir,
			};
			options.onSkillActivated?.(details);
			return {
				content: [{ type: "text", text: formatSkillBlock(skill, body) }],
				details,
			};
		},
	};
}

export function createSkillTool(options: SkillToolOptions = {}): AgentTool<typeof skillSchema, SkillToolDetails> {
	return wrapToolDefinition(createSkillToolDefinition(options));
}
