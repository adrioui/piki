/**
 * Worker context builder — builds scoped context that workers receive.
 * Uses the <session-start>/<project-context>/<transcript> XML structure.
 * Pi extends its existing buildForkContext() from event-core/src/fork.ts.
 *
 * Transcript truncation: last 5-10 messages + any messages explicitly referenced
 * in the delegation message. Project context always included.
 */

import { buildForkContext, type ContextLens, getRoleContextLens, type RoleDef } from "@piki/event-core";

export interface WorkerContextInput {
	sessionStart?: string;
	projectContext?: string;
	transcript?: string;
	maxTranscriptChars?: number;
}

export interface RoleAwareWorkerContextInput {
	roleDef: RoleDef;
	sessionStart?: string;
	projectContext?: string;
	transcript?: string;
	scratchpad?: string;
	processContext?: string;
}

const DEFAULT_TRANSCRIPT_BUDGET = 50_000;

function budgetTranscript(transcript: string, maxChars: number): string {
	if (transcript.length <= maxChars) return transcript;
	if (maxChars <= 0) return "";
	const parts = transcript
		.split(/\n{2,}/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length <= 1) return transcript.slice(Math.max(0, transcript.length - maxChars));

	const first = parts[0]!;
	const kept: string[] = [];
	let remaining = Math.max(0, maxChars - first.length - "\n\n".length);
	for (let i = parts.length - 1; i > 0 && remaining > 0; i--) {
		const part = parts[i]!;
		const cost = part.length + (kept.length > 0 ? "\n\n".length : 0);
		if (cost > remaining) {
			const slice = part.slice(Math.max(0, part.length - remaining));
			if (slice) kept.unshift(`[Earlier content truncated]\n${slice}`);
			break;
		}
		kept.unshift(part);
		remaining -= cost;
	}
	return [first, ...kept].join("\n\n");
}

/**
 * Budget text to a character limit, keeping the most recent content.
 */
function budgetText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 0) return "";
	return text.slice(Math.max(0, text.length - maxChars));
}

/**
 * Build worker context using role-specific context lens settings.
 * Applies transcript budget, project context budget, and conditional
 * inclusion of scratchpad and process context based on the role's lens.
 */
export function buildRoleAwareWorkerContext(input: RoleAwareWorkerContextInput): string {
	const lens = getRoleContextLens(input.roleDef);
	return buildRoleAwareWorkerContextWithLens(input, lens);
}

/**
 * Build worker context with an explicit context lens.
 * Useful when the lens is already resolved.
 */
export function buildRoleAwareWorkerContextWithLens(input: RoleAwareWorkerContextInput, lens: ContextLens): string {
	// Build each section separately so buildForkContext() maps them to the
	// correct XML tags: <session-start>, <project-context>, <transcript>.
	const sessionStartParts: string[] = [];
	const projectContextParts: string[] = [];
	const transcriptParts: string[] = [];

	// Session start (always included, no budget)
	if (input.sessionStart) {
		sessionStartParts.push(input.sessionStart);
	}

	// Project context (budget-limited by lens)
	if (input.projectContext) {
		const budgeted = budgetText(input.projectContext, lens.projectContextBudget);
		if (budgeted) {
			projectContextParts.push(budgeted);
		}
	}

	// Process context (conditional on lens) — goes into project context
	if (input.processContext && lens.includeProcess) {
		projectContextParts.push(input.processContext);
	}

	// Transcript (budget-limited by lens)
	if (input.transcript) {
		const budgeted = budgetTranscript(input.transcript, lens.transcriptBudget);
		if (budgeted) {
			transcriptParts.push(budgeted);
		}
	}

	// Scratchpad (conditional on lens) — goes into transcript
	if (input.scratchpad && lens.includeScratchpad) {
		transcriptParts.push(input.scratchpad);
	}

	return buildForkContext({
		sessionStart: sessionStartParts.join("\n\n"),
		projectContext: projectContextParts.join("\n\n"),
		transcript: transcriptParts.join("\n\n"),
	});
}

export function buildWorkerContext(input: WorkerContextInput): string {
	return buildForkContext({
		sessionStart: input.sessionStart ?? "",
		projectContext: input.projectContext ?? "",
		transcript: budgetTranscript(input.transcript ?? "", input.maxTranscriptChars ?? DEFAULT_TRANSCRIPT_BUDGET),
	});
}
