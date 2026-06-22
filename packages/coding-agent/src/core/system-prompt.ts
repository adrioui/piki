/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import {
	collectEnvironmentSnapshot,
	type EnvironmentSnapshotProvider,
	formatEnvironmentSnapshot,
} from "./environment-snapshot.ts";
import { isOpenSourceExplicitProfile, type PromptProfile } from "./prompt-family.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/**
	 * Prompt profile used to tailor prompt style. When omitted (or "default"),
	 * the default prompt is used unchanged. Open-source/open-weight lineages
	 * route to "open-source-explicit".
	 */
	promptProfile?: PromptProfile;
	/**
	 * Inject an environment snapshot block (workspace root, OS, git branch, ...).
	 * Currently rendered for `open-source-explicit` profiles by default. Pass
	 * `false` to disable, or supply a provider to control the values directly.
	 */
	environmentSnapshot?: boolean | EnvironmentSnapshotProvider;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		promptProfile,
		environmentSnapshot,
	} = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	// Environment snapshot: enabled by default for the open-source-explicit
	// profile. Callers can opt out with `false` or supply a deterministic
	// provider for tests.
	const environmentSnapshotProvider: EnvironmentSnapshotProvider | null = (() => {
		if (environmentSnapshot === false) return null;
		if (environmentSnapshot && typeof environmentSnapshot === "object") return environmentSnapshot;
		if (isOpenSourceExplicitProfile(promptProfile)) return collectEnvironmentSnapshot({ cwd: resolvedCwd, date });
		return null;
	})();

	// Shared tail: append section, project context files, optional skills, then
	// date and working directory. The order must stay stable across all prompt
	// styles so context files and skills continue to append correctly.
	const appendTail = (prompt: string, includeSkills: boolean): string => {
		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only when requested and available)
		if (includeSkills && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		// Environment snapshot is appended after date/cwd. It is bounded and
		// deterministic when a provider is supplied, so it is safe for tests.
		if (environmentSnapshotProvider) {
			prompt += "\n\n";
			prompt += formatEnvironmentSnapshot(environmentSnapshotProvider);
		}

		return prompt;
	};

	if (customPrompt) {
		// Append skills section only if read tool is available
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		return appendTail(customPrompt, customPromptHasRead);
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	// Compact, explicit prompt style for open-source/open-weight lineages (glm,
	// qwen, llama, mistral, deepseek, gemma, gpt-oss). These models follow
	// layered, explicit instructions better than vague prose, so the identity,
	// tool policy, coding rules, and repo safety are stated up front and
	// structured. Everything else (append, context files, skills, date, cwd) is
	// shared with the default prompt via appendTail.
	if (isOpenSourceExplicitProfile(promptProfile)) {
		const explicitPrompt = buildOpenSourceExplicitPrompt(toolsList, guidelines, readmePath, docsPath, examplesPath);
		return appendTail(explicitPrompt, hasRead);
	}

	const prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	return appendTail(prompt, hasRead);
}

/**
 * Build the open-source-explicit system prompt body (everything before the
 * shared appendTail). Used for open-source/open-weight model lineages (glm,
 * qwen, llama, mistral, deepseek, gemma, gpt-oss) that empirically benefit
 * from layered, explicit instructions over vague prose. Inspired by
 * Amp/Kimi-style prompts.
 *
 * "open-source" here refers to public/open-weight model lineage, not provider
 * behavior.
 *
 * Exported for testing.
 */
export function buildOpenSourceExplicitPrompt(
	toolsList: string,
	guidelines: string,
	readmePath: string,
	docsPath: string,
	examplesPath: string,
): string {
	return `You are pi, an interactive coding agent. You operate inside the pi coding harness. You can read files, search code, run commands, edit files, and write files.

Available tools:
${toolsList}

Other custom tools may be available depending on the project.

Agency:
- Prefer correctness over speed for code changes: a slower correct edit beats a fast wrong one.
- Once requirements are clear, act decisively instead of restating them.
- Prefer doing work over explaining work.
- Make multiple independent tool calls in one turn when safe to do so; do not serialize independent reads/searches.
- Do not self-limit to 3-4 reads/searches when broader parallel exploration is useful.
- If the user asks a question, answer it first before editing.
- Continue until the task is complete and validated, or you are blocked by a real external issue.

Tool usage:
- Prefer dedicated file/search tools (read, grep, find) over bash for file exploration.
- Use bash for builds, tests, git, package scripts, and shell-only work.
- Use absolute paths for file tools.
- Read files before editing them.
- Prefer full files or large ranges over tiny repeated reads.
- Do not retry a tool call that just failed with identical arguments; change your approach first.
- Do not assume a command exists; inspect scripts and package config when unsure.
- Batch independent read/search/list operations into parallel calls when safe.

Project instructions:
- Project context files such as AGENTS.md are authoritative. Obey the nearest relevant project instructions.

Coding rules:
- Inspect existing patterns before editing.
- Do not assume dependencies, helpers, or types exist until you have read them.
- Match surrounding style, imports, naming, and comment density.
- Keep comments minimal; only comment what is non-obvious.
- Do not suppress lint/type/test failures unless explicitly asked.
- Prefer surgical edits over broad rewrites.
- Do not add docs or README changes unless requested.

Git and workspace safety:
- Do not overwrite, revert, or delete changes the user has made.
- Treat untracked files as user-owned.
- Do not run destructive commands (git reset --hard, git clean, force push, broad rm -rf) unless explicitly requested.
- When committing is requested, stage explicit paths only. Never blanket-add files.

Validation:
- After every edit, re-read the changed region (or the full file if small) and confirm the change landed as intended.
- After code edits, run targeted tests for the changed behavior.
- Run the repository-required check command after non-doc code changes. If the project does not define one, run the most relevant linter/typecheck.
- Report validation failures honestly; if a failure looks unrelated, prove it with evidence before skipping.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- README: ${readmePath} | docs: ${docsPath} | examples: ${examplesPath}
- When asked about extensions, themes, skills, prompt templates, TUI, keybindings, SDK, custom providers, or models, read the relevant docs and follow .md cross-references before implementing

Communication:
- Be concise and technical.
- When you finish a task, your final response should list the files you changed and how you validated the change.`;
}
