/**
 * Thinking Governor - Phase 7.
 *
 * Counts thinking_delta characters per role and aborts/retries with
 * overthinking feedback when the accumulated thinking exceeds maxThoughtChars.
 * Counters are reset after a retry or successful completion.
 *
 * Overthinking prevention: open-weight models can
 * get stuck in long thinking loops. The governor caps thinking length
 * and signals the agent to stop overthinking and act.
 */

import { ROLE_DEFINITIONS, type RoleDef } from "@piki/event-core";

export interface ThinkingGovernorOptions {
	/** Callback when overthinking is detected. */
	onOverthinking?: (info: OverthinkingInfo) => void;
}

export interface OverthinkingInfo {
	role: string;
	charCount: number;
	limit: number;
	/** Feedback message to inject back into the agent context. */
	feedback: string;
}

/**
 * Tracks thinking character counts per role and detects overthinking.
 *
 * The governor is designed to be called on each thinking_delta event.
 * When the accumulated character count exceeds the role's maxThoughtChars,
 * it fires the onOverthinking callback with corrective feedback.
 */
export class ThinkingGovernor {
	private readonly counts = new Map<string, number>();
	private readonly options: ThinkingGovernorOptions;

	constructor(options: ThinkingGovernorOptions = {}) {
		this.options = options;
	}

	/**
	 * Record a thinking delta for a role. Returns true if overthinking
	 * was detected (the caller should abort/retry the current turn).
	 */
	recordDelta(role: string, deltaText: string): boolean {
		const current = this.counts.get(role) ?? 0;
		const updated = current + deltaText.length;
		this.counts.set(role, updated);

		const limit = this.getLimit(role);
		if (updated > limit) {
			const info: OverthinkingInfo = {
				role,
				charCount: updated,
				limit,
				feedback: this.buildFeedback(role, updated, limit),
			};
			this.options.onOverthinking?.(info);
			return true;
		}
		return false;
	}

	/**
	 * Reset the counter for a role (after retry or successful completion).
	 */
	reset(role: string): void {
		this.counts.delete(role);
	}

	/**
	 * Reset all counters.
	 */
	resetAll(): void {
		this.counts.clear();
	}

	/**
	 * Get the max thought chars limit for a role.
	 */
	getLimit(role: string): number {
		const def: RoleDef | undefined = ROLE_DEFINITIONS[role];
		return def?.maxThoughtChars ?? 12000;
	}

	private buildFeedback(role: string, count: number, limit: number): string {
		return [
			`<overthinking_warning>`,
			`Role "${role}" has produced ${count} characters of thinking (limit: ${limit}).`,
			"Stop thinking and take action now. Summarize your conclusion in one sentence and proceed to the next tool call.",
			`</overthinking_warning>`,
		].join("\n");
	}
}
