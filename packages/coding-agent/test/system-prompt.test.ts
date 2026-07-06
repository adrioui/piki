import { describe, expect, test } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

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

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve piki docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Piki documentation");
			expect(prompt).toMatch(/README: .+ \| docs: .+ \| examples: .+/);
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("prompt profile routing", () => {
		test("default prompt is unchanged when no promptProfile is set", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			// Default identity and docs section are present
			expect(prompt).toContain("You are an expert coding assistant operating inside piki");
			expect(prompt).toContain("Piki documentation");
			// Open-source explicit identity is NOT present
			expect(prompt).not.toContain("You are piki, an interactive coding agent.");
			expect(prompt).not.toContain("Tool usage:");
		});

		test("default profile keeps the default prompt", () => {
			const prompt = buildSystemPrompt({
				promptVariant: "default",
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});
			expect(prompt).toContain("You are an expert coding assistant operating inside piki");
			expect(prompt).not.toContain("Tool usage:");
		});

		test("open-source-explicit profile gets the reliability-first explicit prompt", () => {
			const prompt = buildSystemPrompt({
				promptVariant: "open-source-explicit",
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			// Identity
			expect(prompt).toContain("You are piki, an interactive coding agent.");
			expect(prompt).toContain("piki coding harness");
			// Major explicit reliability sections
			expect(prompt).toContain("Agency:");
			expect(prompt).toContain("Prefer correctness over speed for code changes");
			expect(prompt).not.toContain("SPEED FIRST");
			expect(prompt).toContain("Tool usage:");
			expect(prompt).toContain("Prefer dedicated file/search tools (read, grep, find) over bash");
			expect(prompt).toContain("Do not retry a tool call that just failed with identical arguments");
			expect(prompt).toContain("Batch independent read/search/list operations into parallel calls when safe.");
			expect(prompt).toContain("After every edit, re-read the changed region");
			expect(prompt).toContain("Run the repository-required check command after non-doc code changes");
			expect(prompt).toContain("Project instructions:");
			expect(prompt).toContain("Coding rules:");
			expect(prompt).toContain("Git and workspace safety:");
			expect(prompt).toContain("Validation:");
			expect(prompt).toContain("Communication:");
			// Piki docs guidance is still present (condensed)
			expect(prompt).toContain("Piki documentation");
			// Default verbose identity is gone
			expect(prompt).not.toContain("You are an expert coding assistant operating inside piki");
		});

		test("open-source-explicit prompt includes economics section", () => {
			const prompt = buildSystemPrompt({
				promptVariant: "open-source-explicit",
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Economics:");
			expect(prompt).toContain("Thinking costs output tokens and time.");
			expect(prompt).toContain("Do not recite file contents");
			expect(prompt).toContain("Batch independent tool calls into a single turn");
		});

		test("default prompt does NOT include economics section", () => {
			const prompt = buildSystemPrompt({
				promptVariant: "default",
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("Economics:");
		});

		test("open-source-explicit prompt includes condensed piki docs guidance with README/docs/examples paths", () => {
			const prompt = buildSystemPrompt({
				promptVariant: "open-source-explicit",
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			// The condensed docs block lists README/docs/examples pointer and the
			// follow-cross-references rule.
			expect(prompt).toContain("Piki documentation");
			expect(prompt).toMatch(/README: .+ \| docs: .+ \| examples: .+/);
			expect(prompt).toContain("follow .md cross-references before implementing");
		});

		test("selected tool snippets still appear in open-source-explicit prompt", () => {
			const prompt = buildSystemPrompt({
				promptVariant: "open-source-explicit",
				selectedTools: ["read", "bash"],
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read: Read file contents");
			expect(prompt).toContain("- bash: Execute bash commands");
		});

		test("context files still append in open-source-explicit prompt", () => {
			const prompt = buildSystemPrompt({
				promptVariant: "open-source-explicit",
				contextFiles: [{ path: "AGENTS.md", content: "Always run npm run check." }],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<project_context>");
			expect(prompt).toContain('<project_instructions path="AGENTS.md">');
			expect(prompt).toContain("Always run npm run check.");
		});

		test("skills still append in open-source-explicit prompt when read tool is available", () => {
			const prompt = buildSystemPrompt({
				promptVariant: "open-source-explicit",
				selectedTools: ["read", "bash"],
				toolSnippets: { read: "Read file contents" },
				skills: [makeSkill("docx", "Create DOCX documents")],
				cwd: process.cwd(),
			});

			expect(prompt.toLowerCase()).toContain("docx");
		});

		test("date and working directory append in open-source-explicit prompt", () => {
			const prompt = buildSystemPrompt({
				promptVariant: "open-source-explicit",
				contextFiles: [],
				skills: [],
				cwd: "/custom/cwd",
				environmentSnapshot: false,
			});

			expect(prompt).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
			expect(prompt).toContain("Current working directory: /custom/cwd");
		});

		test("open-source-explicit prompt can append a bounded environment snapshot", () => {
			const prompt = buildSystemPrompt({
				promptVariant: "open-source-explicit",
				contextFiles: [],
				skills: [],
				cwd: "/custom/cwd",
				environmentSnapshot: {
					date: "2026-06-21",
					cwd: "/custom/cwd",
					workspaceRoot: "/custom",
					os: "linux",
					shell: "bash",
					timezone: "UTC",
					hostname: "host-a",
					username: "user-a",
					gitBranch: "main",
					gitStatus: [],
					recentCommits: [],
					repoUrl: "git@example.com:repo.git",
					folderStructure: ["package.json", "src/"],
					loadedSkills: [],
				},
			});

			expect(prompt).toContain("Environment snapshot:");
			expect(prompt).toContain("- date: 2026-06-21");
			expect(prompt).toContain("- cwd: /custom/cwd");
			expect(prompt).toContain("- workspace_root: /custom");
			expect(prompt).toContain("- os: linux");
			expect(prompt).toContain("- hostname: host-a");
			expect(prompt).toContain("- username: user-a");
			expect(prompt).toContain("- git_branch: main");
			expect(prompt).toContain("- repo_url: git@example.com:repo.git");
			expect(prompt).toContain("package.json");
			expect(prompt).toContain("src/");
		});
	});
});
