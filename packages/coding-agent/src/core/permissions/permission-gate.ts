/**
 * Amp-style permission policy engine.
 *
 * Provides ordered first-match-wins rule evaluation for tool call interception.
 * Rules can match by tool name (exact, glob, regex) and nested input properties.
 * Default deny when no rule matches in headless/execute contexts.
 */

import { classifyShellCommand } from "./shell-classifier.ts";

export type PermissionAction = "allow" | "reject" | "ask" | "delegate";

export interface PermissionRule {
	/** Tool name pattern: exact string, glob pattern (with * or **), or /regex/ string. */
	tool: string;
	/** Action to take when this rule matches. */
	action: PermissionAction;
	/**
	 * Optional nested input field matchers.
	 * Dot-separated keys (e.g. "input.command") with exact, glob, or regex values.
	 * All must match for the rule to fire.
	 */
	matches?: Record<string, string>;
	/** Context restriction: only match in "thread" or "subagent" mode. */
	context?: "thread" | "subagent";
	/** Delegate target (for delegate action) */
	to?: string;
	/** User-facing message for reject/ask actions. */
	message?: string;
}

export interface PermissionDecision {
	permitted: boolean;
	action: PermissionAction | null;
	reason?: string;
	matchedEntry?: PermissionRule;
	matchIndex?: number;
	source?: "user" | "role" | "built-in";
}

export interface PermissionGateOptions {
	/** User-defined rules (evaluated first). */
	userRules?: PermissionRule[];
	/** Role identifier. Signals that role policy rules should be applied. */
	roleId?: string;
	/** Pre-computed role policy rules (from getRolePolicyRules). Evaluated
	 * after user rules and before built-in rules when roleId is set. */
	rolePolicyRules?: PermissionRule[];
	/** Whether the current context is interactive (has UI for ask). */
	interactive?: boolean;
	/** Context kind: "thread" or "subagent". */
	context?: "thread" | "subagent";
	/**
	 * Tool names that are registered/known to the runtime. When no rule matches,
	 * known tools are allowed by default so the gate only blocks unregistered
	 * (likely hallucinated) tool calls in headless contexts.
	 */
	knownTools?: string[];
}

/**
 * Check if a pattern matches a value.
 * - exact string: value === pattern
 * - glob pattern (contains * or **): simple glob matching (supports *, **, ?)
 * - /regex/ string: regex test
 */
function patternMatches(pattern: string, value: string): boolean {
	if (pattern.startsWith("/") && pattern.length > 2) {
		// Regex pattern: /pattern/flags
		const lastSlash = pattern.lastIndexOf("/");
		if (lastSlash > 0) {
			const regexStr = pattern.slice(1, lastSlash);
			const flags = pattern.slice(lastSlash + 1);
			try {
				return new RegExp(regexStr, flags).test(value);
			} catch {
				return false;
			}
		}
	}

	if (pattern.includes("*") || pattern.includes("?")) {
		return globMatch(pattern, value);
	}

	return pattern === value;
}

/**
 * Simple glob matching.
 * Supports * (any chars), ** (any path segments), ? (single char).
 */
function globMatch(pattern: string, value: string): boolean {
	const parts = pattern.split(/(\*\*?|\?)/g);
	let regexStr = "";
	for (const part of parts) {
		if (part === "**") {
			regexStr += ".*";
		} else if (part === "*") {
			regexStr += "[^/]*";
		} else if (part === "?") {
			regexStr += ".";
		} else {
			regexStr += part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	try {
		return new RegExp(`^${regexStr}$`).test(value);
	} catch {
		return false;
	}
}

/**
 * Resolve a dot-separated key path against an object.
 * Returns undefined if any path segment is missing.
 */
function resolveKeyPath(obj: Record<string, unknown>, path: string): unknown {
	const segments = path.split(".");
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Evaluate a single rule against a tool call.
 */
function ruleMatches(
	rule: PermissionRule,
	toolName: string,
	input: Record<string, unknown>,
	contextKind?: string,
): boolean {
	// Context filter
	if (rule.context && rule.context !== contextKind) {
		return false;
	}

	// Tool name match
	if (!patternMatches(rule.tool, toolName)) {
		return false;
	}

	// Input field matchers (all must match)
	if (rule.matches) {
		for (const [key, pattern] of Object.entries(rule.matches)) {
			const value = resolveKeyPath(input, key);
			if (value === undefined || value === null) {
				return false;
			}
			if (!patternMatches(pattern, String(value))) {
				return false;
			}
		}
	}

	return true;
}

function evaluateDelegateRule(
	rule: PermissionRule,
	toolName: string,
	input: Record<string, unknown>,
): Pick<PermissionDecision, "permitted" | "action" | "reason"> {
	void toolName;
	void input;
	return {
		permitted: false,
		action: "delegate",
		reason: rule.message ?? "Delegate actions are not supported by this permission gate.",
	};
}

function reasonForAction(action: PermissionAction, message?: string): string {
	if (message) {
		return message;
	}
	switch (action) {
		case "ask":
			return "This action requires explicit user confirmation before it can run.";
		case "delegate":
			return "Delegated to external permission program.";
		case "reject":
			return "Rejected by permission policy.";
		case "allow":
			return "Allowed by permission policy.";
	}
}

const BUILT_IN_RULES: PermissionRule[] = [
	// Always allow read-only tools
	{ tool: "read", action: "allow" },
	{ tool: "grep", action: "allow" },
	{ tool: "find", action: "allow" },
	{ tool: "ls", action: "allow" },
	{ tool: "web_search", action: "allow" },
	{ tool: "web_fetch", action: "allow" },
	{ tool: "code_search", action: "allow" },
	{ tool: "scratchpad_load", action: "allow" },
	{ tool: "scratchpad_save", action: "allow" },
	{ tool: "compact", action: "allow" },

	// Deny destructive git operations in bash
	{
		tool: "bash",
		action: "reject",
		matches: { command: "/git reset --hard/" },
		message: "Destructive git reset blocked",
	},
	{
		tool: "bash",
		action: "reject",
		matches: { command: "/git clean .*-(?:[^\\s]*f[^\\s]*d|[^\\s]*d[^\\s]*f)/" },
		message: "Destructive git clean blocked",
	},
	{
		tool: "bash",
		action: "reject",
		matches: { command: "/git commit .*--no-verify/" },
		message: "Bypassing git commit hooks is blocked",
	},
	{
		tool: "bash",
		action: "reject",
		matches: { command: "/git push .*(?:-f|--force|--force-with-lease)/" },
		message: "Destructive git push blocked",
	},
	{ tool: "bash", action: "reject", matches: { command: "/git stash/" }, message: "Destructive git stash blocked" },
	{ tool: "bash", action: "reject", matches: { command: "/git add -A/" }, message: "Destructive git add blocked" },
	{ tool: "bash", action: "reject", matches: { command: "/git add \\./" }, message: "Destructive git add blocked" },
	{ tool: "bash", action: "reject", matches: { command: "/rm -rf \\//" }, message: "Recursive rm blocked" },
	{ tool: "bash", action: "reject", matches: { command: "/rm -rf ~/" }, message: "Recursive rm blocked" },
	{ tool: "bash", action: "reject", matches: { command: "/chmod -R 777/" }, message: "Permissive chmod blocked" },

	// Allow mutating file tools (guarded-path policy blocks sensitive targets)
	{ tool: "write", action: "allow" },
	{ tool: "edit", action: "allow" },
	{ tool: "edit-diff", action: "allow" },

	// Allow bash for general commands (after dangerous patterns are rejected)
	{ tool: "bash", action: "allow" },
];

/**
 * Determine whether a tool call should be allowed, rejected, demanded confirmation,
 * or delegated based on user and built-in rules.
 *
 * Rules are evaluated in order: user rules first, then built-in rules.
 * First matching rule wins. If no rule matches, the call is denied by default
 * in non-interactive contexts and configurable in interactive contexts.
 */
export function evaluatePermission(
	toolName: string,
	input: Record<string, unknown>,
	options: PermissionGateOptions = {},
): PermissionDecision {
	const contextKind = options.context;
	const userRules = options.userRules ?? [];
	for (let i = 0; i < userRules.length; i++) {
		const rule = userRules[i]!;
		if (ruleMatches(rule, toolName, input, contextKind)) {
			const delegated = rule.action === "delegate" ? evaluateDelegateRule(rule, toolName, input) : undefined;
			return {
				permitted: delegated?.permitted ?? rule.action === "allow",
				action: delegated?.action ?? rule.action,
				reason: delegated?.reason ?? reasonForAction(rule.action, rule.message),
				matchedEntry: rule,
				matchIndex: i,
				source: "user",
			};
		}
	}

	// Role policy rules (evaluated after user rules, before built-in rules).
	// Only applied when a roleId is provided.
	if (options.roleId && options.rolePolicyRules) {
		const rolePolicy = options.rolePolicyRules;
		for (let i = 0; i < rolePolicy.length; i++) {
			const rule = rolePolicy[i]!;
			if (ruleMatches(rule, toolName, input, contextKind)) {
				return {
					permitted: rule.action === "allow",
					action: rule.action,
					reason: reasonForAction(rule.action, rule.message),
					matchedEntry: rule,
					matchIndex: userRules.length + i,
					source: "role",
				};
			}
		}
	}

	if (toolName === "bash" && typeof input.command === "string") {
		const shellClassification = classifyShellCommand(input.command);
		if (shellClassification.level === "forbidden" || shellClassification.level === "mass-destructive") {
			return {
				permitted: false,
				action: "reject",
				reason: shellClassification.reason,
				source: "built-in",
			};
		}
	}

	for (let i = 0; i < BUILT_IN_RULES.length; i++) {
		const rule = BUILT_IN_RULES[i]!;
		if (ruleMatches(rule, toolName, input, contextKind)) {
			return {
				permitted: rule.action === "allow",
				action: rule.action,
				reason: reasonForAction(rule.action, rule.message),
				matchedEntry: rule,
				matchIndex: userRules.length + i,
				source: "built-in",
			};
		}
	}

	// Known/registered tools are allowed by default when no explicit rule matched.
	// Non-interactive (headless/execute) contexts still deny unknown tools via the
	// default deny below — known tools are always allowed regardless of context.
	const knownTools = options.knownTools ?? [];
	if (knownTools.includes(toolName)) {
		return {
			permitted: true,
			action: "allow",
			reason: "Allowed by default; tool is registered with the runtime",
			source: "built-in",
		};
	}

	// Default deny for non-interactive contexts
	if (!options.interactive) {
		return {
			permitted: false,
			action: "reject",
			reason: "No matching permission rule and default is deny in this context",
			source: "built-in",
		};
	}

	// In interactive mode, warn but allow unknown tools
	return {
		permitted: true,
		action: "allow",
		reason: "No matching rule; allowed by default in interactive context",
		source: "built-in",
	};
}
