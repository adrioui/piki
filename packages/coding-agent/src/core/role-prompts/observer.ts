export const JUSTIFICATION_VALUES = ["difficulty", "churn", "frustration"] as const;

export const JUSTIFICATION_TEMPLATES = {
	difficulty:
		"System has detected a high-difficulty task. Review whether the coordinator has decomposed the work correctly, gathered enough evidence, assigned the right worker roles, and chosen verification that would actually catch failure. Push for a smaller observable next step if the plan is vague.",
	churn: "System has detected a high level of churn. Look for repeated failed actions, circular investigation, conflicting worker outputs, or edits that do not move toward the goal. Intercept with a concrete reset: identify the current blocker, the next file or command to inspect, and what result would change the plan.",
	frustration:
		"System has detected user frustration. Re-center on the user's latest instruction, remove defensiveness, and demand visible progress. Be direct about what remains, what is being fixed now, and what evidence will prove completion. Do not let the coordinator hide behind process or partial success.",
} as const;
