/**
 * Per-role permission policy.
 *
 * Provides a uniform deny stack applied across all roles. The same set of
 * safety rules is returned regardless of roleId — the parameter exists so
 * future role-specific customisation can be layered in without changing the
 * caller interface.
 *
 * Rule evaluation order in the permission gate:
 *   user rules → role policy → built-in rules → default deny/allow
 *
 * The role policy slots between user rules and built-in rules. It adds
 * restrictive guardrails that apply when a roleId is provided (typically
 * for worker sessions). When no roleId is given, the gate skips this
 * layer entirely, preserving existing leader/thread behaviour.
 */

import { homedir } from "node:os";
import type { PermissionRule } from "./permission-gate.ts";

/**
 * Escape a string for use inside a regex pattern.
 */
function escapeRegex(s: string): string {
	return s.replace(/[/.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the ordered set of permission rules for a given role.
 *
 * @param _roleId - Reserved for future per-role differentiation.
 * @param cwd - Project working directory. Writes outside this path are
 *   rejected (the directory itself is still allowed).
 * @param scratchpadPath - Scratchpad directory. Writes here are allowed.
 */
export interface RolePolicyOptions {
	disableCwdSafeguards?: boolean;
	disableShellSafeguards?: boolean;
}

export function getRolePolicyRules(
	_roleId?: string,
	_cwd?: string,
	_scratchpadPath?: string,
	opts?: RolePolicyOptions,
): PermissionRule[] {
	const home = homedir();
	const rules: PermissionRule[] = [];

	// 1. Deny writes outside allowed directories (cwd, scratchpad, ~/.piki).
	// The write/edit/edit-diff boundary is enforced dynamically inside
	// `evaluatePermission` (it must resolve `../`/`./` and `$M` against cwd,
	// which a static `matches.path` regex cannot do). See permission-gate.ts.

	// 2. Deny mass-destructive rm targeting ~/.piki
	if (!opts?.disableShellSafeguards) {
		const escapedHome = escapeRegex(home);
		rules.push({
			tool: "/^(bash|shell)$/",
			action: "reject",
			matches: { command: `/rm\\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\\s+${escapedHome}\\.piki/` },
			message: "Mass-destructive rm in ~/.piki blocked by role policy",
		});
		rules.push({
			tool: "/^(bash|shell)$/",
			action: "reject",
			matches: { command: `/rm\\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\\s+${escapedHome}\\.piki/` },
			message: "Mass-destructive rm in ~/.piki blocked by role policy",
		});
	}

	return rules;
}
