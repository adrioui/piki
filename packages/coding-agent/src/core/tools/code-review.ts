/**
 * code_review tool - Run Amp-style review checks against changed code.
 *
 * One subagent per check. Each check subagent inspects the provided diff/paths
 * with read-only tools (plus any tools the check declares) and returns
 * structured findings. Check subagents never edit files.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { CHECK_BASELINE_TOOLS, type ReviewCheck, resolveCheckTools } from "../review-checks.ts";
import { runSubagent, type SubagentTool } from "../subagent/runtime.ts";

const codeReviewSchema = Type.Object({
	diff: Type.Optional(
		Type.String({
			description:
				"Unified diff of the changes to review. Preferably scoped to the change being checked. If omitted, paths[] must be provided.",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Files (relative or absolute) affected by the change, when a diff is not available.",
		}),
	),
	checks: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional subset of check names to run. Defaults to all discovered checks.",
		}),
	),
});

export type CodeReviewInput = Static<typeof codeReviewSchema>;

export interface CodeReviewFinding {
	file?: string;
	line?: number;
	severity?: string;
	problem: string;
	why?: string;
	fix?: string;
}

export interface CodeReviewCheckResult {
	name: string;
	findings: CodeReviewFinding[];
	summary: string;
	error?: string;
	turns: number;
}

export interface CreateCodeReviewToolDefinitionOptions {
	cwd: string;
	model: Model<string> | (() => Model<string> | undefined);
	tools: SubagentTool[];
	/** All discovered review checks. */
	checks: ReviewCheck[];
	/**
	 * Names of tools the main agent is allowed to delegate to check subagents.
	 * Check subagents only ever receive baseline + declared tools that are also
	 * in this set and in `tools`.
	 */
	delegatableToolNames: string[];
	defaultMaxTurns?: number;
}

function buildCheckSystemPrompt(check: ReviewCheck): string {
	return [
		"You are a code review subagent running inside a coding agent with an isolated context.",
		"You cannot see the parent conversation; work only from the diff/paths and instructions you are given.",
		"You are read-only: never edit or write files.",
		"",
		`You are running the "${check.name}" review check.`,
		check.description ? `Check description: ${check.description}` : "",
		check.severityDefault ? `Default severity for findings: ${check.severityDefault}` : "",
		"",
		"Inspect the changed lines where possible. Focus only on what this check is about.",
		"Use read, grep, find, ls, and bash to confirm your findings against the real code.",
		"",
		"Check instructions:",
		check.instructions || "(no additional instructions)",
		"",
		"Return your findings as a JSON array. Each finding must be an object with:",
		'  - "file": path (string, optional)',
		'  - "line": line number (number, optional)',
		'  - "severity": one of "low", "medium", "high", "critical" (string, optional)',
		'  - "problem": short description of the issue (string, required)',
		'  - "why": why it matters (string, optional)',
		'  - "fix": suggested concrete fix (string, optional)',
		"If there are no findings, return an empty array: []",
		"Output ONLY the JSON array in your final message, no prose around it.",
	]
		.filter((line) => line !== "")
		.join("\n");
}

function extractFindings(text: string): { findings: CodeReviewFinding[]; parseError?: string } {
	const trimmed = text.trim();
	// Try to locate the outermost JSON array.
	const start = trimmed.indexOf("[");
	const end = trimmed.lastIndexOf("]");
	if (start === -1 || end === -1 || end < start) {
		return { findings: [], parseError: "No JSON array found in check output" };
	}
	const jsonText = trimmed.slice(start, end + 1);
	try {
		const parsed = JSON.parse(jsonText) as unknown;
		if (!Array.isArray(parsed)) {
			return { findings: [], parseError: "Check output was not a JSON array" };
		}
		const findings: CodeReviewFinding[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== "object") continue;
			const record = item as Record<string, unknown>;
			const problem = typeof record.problem === "string" ? record.problem : undefined;
			if (!problem) continue; // problem is required
			findings.push({
				file: typeof record.file === "string" ? record.file : undefined,
				line: typeof record.line === "number" ? record.line : undefined,
				severity: typeof record.severity === "string" ? record.severity : undefined,
				problem,
				why: typeof record.why === "string" ? record.why : undefined,
				fix: typeof record.fix === "string" ? record.fix : undefined,
			});
		}
		return { findings };
	} catch (err) {
		return {
			findings: [],
			parseError: `Failed to parse check output JSON: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Create the code_review tool definition.
 *
 * Runs each selected (or all) discovered checks as an isolated read-only
 * subagent and aggregates structured findings.
 */
export function createCodeReviewToolDefinition(
	options: CreateCodeReviewToolDefinitionOptions,
): ToolDefinition<typeof codeReviewSchema> {
	const defaultMaxTurns = options.defaultMaxTurns ?? 10;
	const delegatable = new Set(options.delegatableToolNames);
	const availableToolNames = options.tools.map((t) => t.name);

	return {
		name: "code_review",
		label: "Code Review",
		description:
			"Run Amp-style review checks (.agents/checks/*.md) against a diff or set of changed paths. Each check runs as an isolated read-only subagent and returns structured findings (file, line, severity, problem, why, fix). Use it to review your own changes before reporting done.",
		promptSnippet: "Run project review checks against a diff or changed paths",
		promptGuidelines: [
			"Pass code_review the diff (or changed paths) you want reviewed; it inspects only what you give it.",
			"code_review returns structured findings per check; address must-fix findings and re-run if needed.",
			"Check subagents are read-only and cannot edit files.",
		],
		parameters: codeReviewSchema,
		execute: async (
			_toolCallId: string,
			params: Static<typeof codeReviewSchema>,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> => {
			if (!params.diff && (!params.paths || params.paths.length === 0)) {
				return {
					content: [{ type: "text" as const, text: "Error: provide a diff or at least one path to review." }],
					details: {},
				};
			}

			const selectedNames = params.checks && params.checks.length > 0 ? new Set(params.checks) : undefined;
			const selected = options.checks.filter((c) => !selectedNames || selectedNames.has(c.name));
			if (selected.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: selectedNames
								? `No review checks matched: ${Array.from(selectedNames).join(", ")}`
								: "No review checks are configured for this project.",
						},
					],
					details: { results: [] as CodeReviewCheckResult[] },
				};
			}

			const resolvedModel = typeof options.model === "function" ? options.model() : options.model;
			if (!resolvedModel) {
				return {
					content: [{ type: "text" as const, text: "Error: no model available for review subagent" }],
					details: {},
				};
			}

			const changeDescription = [
				params.diff ? `Diff:\n\`\`\`diff\n${params.diff}\n\`\`\`` : "",
				params.paths && params.paths.length > 0
					? `Affected paths:\n${params.paths.map((p) => `- ${p}`).join("\n")}`
					: "",
			]
				.filter((s) => s.length > 0)
				.join("\n\n");

			const results: CodeReviewCheckResult[] = [];
			for (const check of selected) {
				if (signal?.aborted) break;

				const effectiveTools = resolveCheckTools(check, [...delegatable, ...availableToolNames]).filter(
					(name) => delegatable.has(name) && availableToolNames.includes(name),
				);

				const result = await runSubagent(
					{
						model: resolvedModel,
						systemPrompt: buildCheckSystemPrompt(check),
						userMessage: changeDescription,
						allowedTools: effectiveTools,
						tools: options.tools,
						maxTurns: defaultMaxTurns,
					},
					signal,
				);

				if (result.error) {
					results.push({
						name: check.name,
						findings: [],
						summary: `Check failed: ${result.error}`,
						error: result.error,
						turns: result.turns,
					});
					continue;
				}

				const { findings, parseError } = extractFindings(result.text);
				const total = findings.length;
				const summary = parseError
					? `${check.name}: ${parseError}`
					: `${check.name}: ${total} finding${total === 1 ? "" : "s"}`;
				results.push({
					name: check.name,
					findings,
					summary,
					error: parseError,
					turns: result.turns,
				});
			}

			const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0);
			const textLines: string[] = [];
			textLines.push(`Ran ${results.length} check(s); ${totalFindings} finding(s).`);
			for (const r of results) {
				textLines.push("");
				textLines.push(`## ${r.name} — ${r.findings.length} finding(s)`);
				if (r.findings.length === 0) {
					textLines.push(r.error ? `_Note: ${r.error}_` : "_No findings._");
					continue;
				}
				for (const f of r.findings) {
					const loc = [f.file, f.line !== undefined ? `:${f.line}` : undefined].filter(Boolean).join("");
					const sev = f.severity ? `[${f.severity}] ` : "";
					textLines.push(`- ${sev}${loc ? `${loc} — ` : ""}${f.problem}`);
					if (f.why) textLines.push(`  why: ${f.why}`);
					if (f.fix) textLines.push(`  fix: ${f.fix}`);
				}
			}

			return {
				content: [{ type: "text" as const, text: textLines.join("\n") }],
				details: { results },
			};
		},
	};
}

export { CHECK_BASELINE_TOOLS };
