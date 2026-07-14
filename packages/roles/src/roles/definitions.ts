import { ROLE_DEFINITIONS as EVENT_ROLE_DEFINITIONS } from "@piki/event-core";
import { ROLE_POLICIES, type RolePolicyName } from "../policy.ts";
import { type DefinedPrompt, definePrompt } from "../prompt.ts";
import { ADVISOR_PROMPT } from "../prompts/advisor.ts";
import { OBSERVER_PROMPT } from "../prompts/observer.ts";
import { ROLE_PROMPTS } from "../prompts/shared/worker-base.ts";
import type { RoleToolkit } from "./toolkits.ts";

export type RoleAgentKind = "leader" | "worker" | "observer" | "advisor" | "compact";

export interface RoleLifecycle {
	start: "spawn" | "ambient";
	stop: "finish" | "pass" | "compact";
}

export interface PikiRoleDefinition {
	id: string;
	description: string;
	prompt: DefinedPrompt;
	defaultRecipient?: string;
	agentKind: RoleAgentKind;
	spawnable: boolean;
	maxThoughtChars?: number;
	policy: RolePolicyName;
	toolkit: RoleToolkit;
	lifecycle: RoleLifecycle;
	initialContext?: string;
}

function eventRolePrompt(roleId: string): string {
	const role = EVENT_ROLE_DEFINITIONS[roleId as keyof typeof EVENT_ROLE_DEFINITIONS];
	return ROLE_PROMPTS[roleId] ?? (role ? `Act as the ${role.name} role.` : "Complete the assigned task.");
}

function workerPrompt(rolePrompt: string): DefinedPrompt {
	return definePrompt(rolePrompt);
}

export const ROLE_DEFINITIONS: Record<string, PikiRoleDefinition> = {
	scout: {
		id: "scout",
		description: eventRolePrompt("scout"),
		prompt: workerPrompt(eventRolePrompt("scout")),
		defaultRecipient: "leader",
		agentKind: "worker",
		spawnable: true,
		maxThoughtChars: 6000,
		policy: "readOnly",
		toolkit: "workerBase",
		lifecycle: { start: "spawn", stop: "finish" },
	},
	architect: {
		id: "architect",
		description: eventRolePrompt("architect"),
		prompt: workerPrompt(eventRolePrompt("architect")),
		defaultRecipient: "leader",
		agentKind: "worker",
		spawnable: true,
		maxThoughtChars: 8000,
		policy: "readOnly",
		toolkit: "workerBase",
		lifecycle: { start: "spawn", stop: "finish" },
	},
	engineer: {
		id: "engineer",
		description: eventRolePrompt("engineer"),
		prompt: workerPrompt(eventRolePrompt("engineer")),
		defaultRecipient: "leader",
		agentKind: "worker",
		spawnable: true,
		maxThoughtChars: 8000,
		policy: "worker",
		toolkit: "workerBase",
		lifecycle: { start: "spawn", stop: "finish" },
	},
	critic: {
		id: "critic",
		description: eventRolePrompt("critic"),
		prompt: workerPrompt(eventRolePrompt("critic")),
		defaultRecipient: "leader",
		agentKind: "worker",
		spawnable: true,
		maxThoughtChars: 6000,
		policy: "readOnly",
		toolkit: "criticBase",
		lifecycle: { start: "spawn", stop: "finish" },
	},
	scientist: {
		id: "scientist",
		description: eventRolePrompt("scientist"),
		prompt: workerPrompt(eventRolePrompt("scientist")),
		defaultRecipient: "leader",
		agentKind: "worker",
		spawnable: true,
		maxThoughtChars: 8000,
		policy: "worker",
		toolkit: "workerBase",
		lifecycle: { start: "spawn", stop: "finish" },
	},
	artisan: {
		id: "artisan",
		description: eventRolePrompt("artisan"),
		prompt: workerPrompt(eventRolePrompt("artisan")),
		defaultRecipient: "leader",
		agentKind: "worker",
		spawnable: true,
		maxThoughtChars: 10000,
		policy: "worker",
		toolkit: "workerBase",
		lifecycle: { start: "spawn", stop: "finish" },
	},
	advisor: {
		id: "advisor",
		description: eventRolePrompt("advisor"),
		prompt: definePrompt(ADVISOR_PROMPT),
		defaultRecipient: "leader",
		agentKind: "advisor",
		spawnable: false,
		maxThoughtChars: 8000,
		policy: "readOnly",
		toolkit: "criticBase",
		lifecycle: { start: "ambient", stop: "finish" },
	},
	observer: {
		id: "observer",
		description: eventRolePrompt("observer"),
		prompt: definePrompt(OBSERVER_PROMPT),
		defaultRecipient: "leader",
		agentKind: "observer",
		spawnable: false,
		policy: "observer",
		toolkit: "observerToolkit",
		lifecycle: { start: "ambient", stop: "pass" },
	},
	compact: {
		id: "compact",
		description: "Summarize context into a compact payload.",
		prompt: workerPrompt("Produce a compact summary, reflection, and important files."),
		defaultRecipient: "leader",
		agentKind: "compact",
		spawnable: false,
		policy: "readOnly",
		toolkit: "compactToolkit",
		lifecycle: { start: "ambient", stop: "compact" },
	},
};

// Backwards-compat alias for code/tests that import the legacy name.
export const PIKI_ROLE_DEFINITIONS = ROLE_DEFINITIONS;

export function getRoleDefinition(roleId: string): PikiRoleDefinition | undefined {
	return ROLE_DEFINITIONS[roleId];
}

export function getRolePolicy(roleId: string) {
	const role = getRoleDefinition(roleId);
	return role ? ROLE_POLICIES[role.policy] : undefined;
}
