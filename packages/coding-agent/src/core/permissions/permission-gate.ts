/**
 * Amp-style permission policy engine.
 *
 * Provides ordered first-match-wins rule evaluation for tool call interception.
 * Rules can match by tool name (exact, glob, regex) and nested input properties.
 * Default deny when no rule matches in headless/execute contexts.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

import { expandScratchpadPath } from "@piki/scratchpad";
import { classifyShellCommand, isGitMutation, isPathWithin, writesStayWithin } from "./shell-classifier.ts";

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
	 * When true, forbidden/mass-destructive shell classification and the
	 * destructive built-in rules (destructive git, recursive rm, chmod -R 777)
	 * are allowed. Mirrors Magnitude alpha22 `--disable-shell-safeguards`.
	 * Default: false (safeguards active, default-deny).
	 */
	disableShellSafeguards?: boolean;
	/**
	 * When true, the shell write-boundary (alpha22 `denyWritesOutside`) is
	 * disabled independently of `disableShellSafeguards`. Mirrors Magnitude
	 * alpha22 `--disable-cwd-safeguards`, which only lifts the cwd write
	 * boundary and leaves git/forbidden/mass-destructive blocking intact.
	 * Default: false (boundary active).
	 */
	disableCwdSafeguards?: boolean;
	/**
	 * Current working directory of the session. When provided (with or without
	 * scratchpadPath) the gate enforces Magnitude alpha22's shell write-boundary:
	 * shell redirects / write-path command args must resolve inside
	 * [cwd, scratchpadPath, ~/.piki]. Mirrors alpha22 `denyWritesOutside`.
	 */
	cwd?: string;
	/** Scratchpad path of the session. See `cwd`. */
	scratchpadPath?: string;
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

	// Deny recursive rm of root/home and permissive chmod. Mutating git is
	// blocked separately by the broad `isGitMutation` classifier in
	// evaluatePermission (so all non-read-only git subcommands are denied, not
	// just the few enumerated below).
	// NOTE: Recursive rm of absolute/home paths and permissive chmod are NOT
	// statically rejected here. Magnitude alpha22 (`denyMassDestructiveIn`) only
	// blocks mass-destructive commands that escape the protected roots
	// [cwd, scratchpadPath, ~/.piki] (and `~` itself is outside that set, so it
	// is allowed — matching alpha22's `~/.magnitude` protected root). The
	// `chmod -R 777` case is already caught by the shell classifier
	// (`classifyShellCommand` → forbidden), so no static rule is needed.

	// Allow mutating file tools (guarded-path policy blocks sensitive targets)
	{ tool: "write", action: "allow" },
	{ tool: "edit", action: "allow" },
	{ tool: "edit-diff", action: "allow" },

	// Allow bash for general commands (after dangerous patterns are rejected)
	{ tool: "/^(bash|shell)$/", action: "allow" },
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

	// Dynamic write/edit/edit-diff cwd boundary (alpha22 `denyWritesOutside`).
	// A static `matches.path` regex cannot resolve `../`/`./` and `$M` against
	// cwd, so the boundary is enforced here, mirroring mag's `writeTool.execute`
	// + `expandScratchpadPath` + `isPathWithin`. Applies only when a role policy
	// context is active (leader passes `roleId:"leader"`, workers pass
	// `roleId: <role>`) and the cwd/scratchpad roots exist. `disableCwdSafeguards`
	// lifts it independently of `disableShellSafeguards`.
	if (
		!options.disableCwdSafeguards &&
		options.roleId &&
		(typeof options.cwd === "string" || typeof options.scratchpadPath === "string")
	) {
		const writeBoundaryRoots = [options.cwd, options.scratchpadPath, `${homedir()}/.piki`].filter(
			(root): root is string => Boolean(root),
		);
		const writeBoundaryEnv: Record<string, string> = {
			...process.env,
			HOME: process.env.HOME ?? homedir(),
			M: options.scratchpadPath ?? "",
			PROJECT_ROOT: options.cwd ?? "",
		};
		if (toolName === "write" || toolName === "edit" || toolName === "edit-diff") {
			const rawPath = typeof input.path === "string" ? input.path : "";
			const { path: expanded } = expandScratchpadPath(rawPath, options.scratchpadPath ?? "");
			const fullPath = resolve(options.cwd ?? process.cwd(), expanded);
			if (!isPathWithin(fullPath, writeBoundaryEnv, ...writeBoundaryRoots)) {
				return {
					permitted: false,
					action: "reject",
					reason: "Cannot write files outside allowed directories",
					source: "role",
				};
			}
		}
	}

	if ((toolName === "bash" || toolName === "shell") && typeof input.command === "string") {
		const command = String(input.command);
		// Shell safeguards (git/forbidden/mass-destructive) are gated by
		// `disableShellSafeguards` (alpha22 `--disable-shell-safeguards`).
		if (!options.disableShellSafeguards) {
			const shellClassification = classifyShellCommand(command);
			if (shellClassification.level === "forbidden") {
				return {
					permitted: false,
					action: "reject",
					reason: shellClassification.reason,
					source: "built-in",
				};
			}
			// T3: mass-destructive ops follow alpha22's `denyMassDestructiveIn`
			// two-phase model. Magnitude allows a mass-destructive command when
			// it stays within the non-protected roots [cwd, scratchpadPath]
			// (using the non-strict `writesStayWithin`, which honors the /tmp and
			// /dev/null outside-prefix exemptions), and only rejects it when it
			// escapes those roots but STILL stays within the protected root
			// (~/.piki, the piki rebrand of alpha22's ~/.magnitude). Commands
			// that escape ALL roots fall through to the cwd write-boundary
			// (denyWritesOutside) below, matching alpha22's ordering.
			if (shellClassification.level === "mass-destructive") {
				const pikiHome = `${homedir()}/.piki`;
				// Phase 1: non-protected roots (cwd + scratchpad). When cwd is
				// unset, fall back to process.cwd() so the boundary has a concrete
				// primary root (mirrors mag's `writesStayWithin` `allowedRoots[0]
				// ?? process.cwd()` fallback — never pass `undefined` as a root).
				// The protected ~/.piki root is intentionally NOT included here,
				// so `rm -rf ~/.piki/x` is not allowed by phase 1.
				const cwdRoot = options.cwd ?? process.cwd();
				const nonProtectedRoots: string[] = [cwdRoot];
				if (typeof options.scratchpadPath === "string") nonProtectedRoots.push(options.scratchpadPath);
				const massEnv: Record<string, string> = {
					...process.env,
					HOME: process.env.HOME ?? homedir(),
					M: options.scratchpadPath ?? "",
					PROJECT_ROOT: options.cwd ?? "",
				};
				if (writesStayWithin(command, massEnv, ...nonProtectedRoots)) {
					return {
						permitted: true,
						action: "allow",
						reason: "Mass-destructive allowed within session roots",
						source: "built-in",
					};
				}
				// Phase 2: escapes non-protected roots but stays within the
				// protected root (~/.piki) → rejected.
				const allRoots = [...nonProtectedRoots, pikiHome];
				if (writesStayWithin(command, massEnv, ...allRoots)) {
					return {
						permitted: false,
						action: "reject",
						reason: "Mass-destructive operations are not allowed in protected directories",
						source: "built-in",
					};
				}
				// Otherwise escapes all roots → fall through to the cwd
				// write-boundary (denyWritesOutside) below.
			}
			// Block all mutating git commands (alpha22 denies any non-read-only git).
			if (isGitMutation(command)) {
				return {
					permitted: false,
					action: "reject",
					reason: "Only read-only git commands are allowed",
					source: "built-in",
				};
			}
		}
		// T2: the shell write-boundary (alpha22 `denyWritesOutside`) is gated by
		// the INDEPENDENT `disableCwdSafeguards` flag, not by
		// `disableShellSafeguards`. This matches alpha22 where cwd-boundary and
		// shell-safeguard toggles are separate.
		if (
			!options.disableCwdSafeguards &&
			(typeof options.cwd === "string" || typeof options.scratchpadPath === "string")
		) {
			const roots = [options.cwd, options.scratchpadPath, `${homedir()}/.piki`].filter((root): root is string =>
				Boolean(root),
			);
			const shellEnv: Record<string, string> = {
				...process.env,
				HOME: process.env.HOME ?? homedir(),
				M: options.scratchpadPath ?? "",
				PROJECT_ROOT: options.cwd ?? "",
			};
			if (!writesStayWithin(command, shellEnv, ...roots)) {
				return {
					permitted: false,
					action: "reject",
					reason: "Command targets paths outside allowed directories",
					source: "built-in",
				};
			}
		}
	}

	// T2/G1 write/edit/edit-diff cwd write-boundary: now enforced solely by the
	// two-step resolver block earlier in this function (the `expandScratchpadPath`
	// + `resolve(cwd, expanded)` + `isPathWithin` check that mirrors Magnitude
	// alpha22 `denyWritesOutside`). The previous second raw-path `isPathWithin`
	// check has been removed — it tilde-expanded `~/x` to `$HOME/x` and rejected
	// mag-equivalent writes, diverging from Magnitude which keeps `~` literal as
	// `<cwd>/~/x`. The earlier block already covers this case with mag-parity
	// resolution, so no standalone re-check is needed here.

	const builtInRules = options.disableShellSafeguards
		? BUILT_IN_RULES.filter((rule) => !(rule.action === "reject" && rule.tool === "/^(bash|shell)$/"))
		: BUILT_IN_RULES;
	for (let i = 0; i < builtInRules.length; i++) {
		const rule = builtInRules[i]!;
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
