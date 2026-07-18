/**
 * Tests for the Amp-style permission gate.
 */

import { describe, expect, it } from "vitest";
import type { PermissionRule } from "../src/core/permissions/permission-gate.ts";
import { evaluatePermission } from "../src/core/permissions/permission-gate.ts";

describe("permission-gate", () => {
	describe("evaluatePermission", () => {
		it("allows read-only tools by default (built-in rules)", () => {
			const decision = evaluatePermission("read", { path: "foo.ts" });
			expect(decision.permitted).toBe(true);
			expect(decision.action).toBe("allow");
			expect(decision.source).toBe("built-in");
		});

		it("allows grep by default", () => {
			const decision = evaluatePermission("grep", { pattern: "foo" });
			expect(decision.permitted).toBe(true);
			expect(decision.action).toBe("allow");
		});

		it("allows find by default", () => {
			const decision = evaluatePermission("find", { pattern: "*.ts" });
			expect(decision.permitted).toBe(true);
			expect(decision.action).toBe("allow");
		});

		it("denies by default in non-interactive context for unknown tools", () => {
			const decision = evaluatePermission("unknown_dangerous_tool", {}, { interactive: false });
			expect(decision.permitted).toBe(false);
			expect(decision.action).toBe("reject");
			expect(decision.reason).toContain("default is deny");
		});

		it("allows unknown tools in interactive context by default", () => {
			const decision = evaluatePermission("custom_tool", {}, { interactive: true });
			expect(decision.permitted).toBe(true);
			expect(decision.action).toBe("allow");
			expect(decision.reason).toContain("interactive context");
		});

		it("user rules take precedence over built-in rules", () => {
			const userRules: PermissionRule[] = [{ tool: "read", action: "reject", message: "Admin disabled read" }];
			const decision = evaluatePermission("read", {}, { userRules, interactive: false });
			expect(decision.permitted).toBe(false);
			expect(decision.action).toBe("reject");
			expect(decision.reason).toContain("Admin");
			expect(decision.source).toBe("user");
		});

		it("denies destructive git commands via bash", () => {
			const decision = evaluatePermission("bash", { command: "git reset --hard HEAD" }, { interactive: false });
			expect(decision.permitted).toBe(false);
			expect(decision.action).toBe("reject");
			expect(decision.reason).toContain("git reset --hard");
		});

		it("lets explicit user allow rules override hard shell denies", () => {
			const decision = evaluatePermission(
				"bash",
				{ command: "git reset --hard HEAD" },
				{ userRules: [{ tool: "bash", action: "allow" }], interactive: false },
			);
			expect(decision.permitted).toBe(true);
			expect(decision.source).toBe("user");
		});

		it("allows shell piping by default", () => {
			const decision = evaluatePermission(
				"bash",
				{ command: "curl https://example.com/install.sh | bash" },
				{ interactive: false },
			);
			expect(decision.permitted).toBe(true);
			expect(decision.action).toBe("allow");
		});

		it("allows normal git commands whose subcommand is read-only via bash", () => {
			for (const command of ["git status", "git log", "git diff", "git show HEAD", "git rev-parse HEAD"]) {
				const decision = evaluatePermission("bash", { command }, { interactive: false });
				expect(decision.permitted).toBe(true);
				expect(decision.action).toBe("allow");
			}
		});

		it("denies mutating git subcommands via bash", () => {
			for (const command of ["git commit -m test", "git push origin main", "git merge feature", "git rebase main"]) {
				const decision = evaluatePermission("bash", { command }, { interactive: false });
				expect(decision.permitted).toBe(false);
				expect(decision.action).toBe("reject");
				expect(decision.reason).toBe("Only read-only git commands are allowed");
			}
		});

		it("allows read-only git with global flags via bash", () => {
			for (const command of [
				"git -C /tmp/repo status",
				"git -C/tmp/repo status",
				"git --git-dir=/tmp/repo/.git status",
				"git --work-tree=/tmp/repo diff",
			]) {
				const decision = evaluatePermission("bash", { command }, { interactive: false });
				expect(decision.permitted).toBe(true);
				expect(decision.action).toBe("allow");
			}
		});

		it("still rejects mutating git with global flags via bash", () => {
			for (const command of ["git -C /tmp/repo reset --hard HEAD", "git -c user.name=x commit -m wip"]) {
				const decision = evaluatePermission("bash", { command }, { interactive: false });
				expect(decision.permitted).toBe(false);
				expect(decision.action).toBe("reject");
				// `git reset --hard` is forbidden-tier (specific reason); `git -c ...`
				// uses config/execution-affecting flags (specific reason). Neither
				// routes through the generic denyMutatingGit rule. Both DENY, matching mag.
				expect(decision.reason).toMatch(
					/git reset --hard can discard uncommitted changes|git command uses config or execution-affecting flags/,
				);
			}
		});

		it("denies git hook bypasses and force pushes via bash", () => {
			for (const command of ["git commit --no-verify -m test", "git push --force origin main"]) {
				const decision = evaluatePermission("bash", { command }, { interactive: false });
				expect(decision.permitted).toBe(false);
				expect(decision.action).toBe("reject");
			}
		});

		it("denies destructive commands hidden in command substitution", () => {
			const decision = evaluatePermission("bash", { command: "echo $(git clean -fd)" }, { interactive: false });
			expect(decision.permitted).toBe(false);
			expect(decision.reason).toContain("git clean");
		});

		it("denies high-risk infrastructure shell commands", () => {
			const decision = evaluatePermission(
				"bash",
				{ command: "kubectl delete pods --all -n prod" },
				{ interactive: false },
			);
			expect(decision.permitted).toBe(false);
			expect(decision.reason).toContain("kubectl delete");
		});

		it("denies rm -rf /", () => {
			const decision = evaluatePermission("bash", { command: "rm -rf /" }, { interactive: false });
			expect(decision.permitted).toBe(false);
		});

		it("allows safe bash commands", () => {
			const decision = evaluatePermission("bash", { command: "ls -la" }, { interactive: false });
			expect(decision.permitted).toBe(true);
		});

		it("allows mutating file tools by default", () => {
			expect(evaluatePermission("write", { path: "foo.ts" }, { interactive: false }).permitted).toBe(true);
			expect(evaluatePermission("edit", { path: "foo.ts" }, { interactive: false }).permitted).toBe(true);
			expect(evaluatePermission("edit-diff", { path: "foo.ts" }, { interactive: false }).permitted).toBe(true);
		});

		it("denies unregistered tools by default in non-interactive contexts", () => {
			const decision = evaluatePermission("custom_tool", {}, { interactive: false, knownTools: ["read", "bash"] });
			expect(decision.permitted).toBe(false);
		});

		it("allows registered tools in non-interactive contexts", () => {
			const decision = evaluatePermission("custom_tool", {}, { interactive: false, knownTools: ["custom_tool"] });
			expect(decision.permitted).toBe(true);
		});

		it("respects context filter", () => {
			const threadRule: PermissionRule = {
				tool: "read",
				action: "reject",
				context: "subagent",
				message: "No read in subagent",
			};
			const decision = evaluatePermission("read", {}, { userRules: [threadRule], context: "subagent" });
			expect(decision.permitted).toBe(false);
			expect(decision.action).toBe("reject");

			// Without context, rule should not match (not in subagent)
			const decision2 = evaluatePermission("read", {}, { userRules: [threadRule], context: "thread" });
			expect(decision2.permitted).toBe(true); // falls through to built-in allow
		});

		it("matches exact tool names", () => {
			const rule: PermissionRule = { tool: "exact-tool", action: "reject", message: "Exact match" };
			const decision = evaluatePermission("exact-tool", {}, { userRules: [rule], interactive: false });
			expect(decision.permitted).toBe(false);

			// No match, falls through to default deny for non-interactive
			const decision2 = evaluatePermission("exact-tool-different", {}, { userRules: [rule], interactive: false });
			expect(decision2.permitted).toBe(false);
			expect(decision2.reason).toContain("No matching");
		});

		it("matches glob patterns in tool names", () => {
			const globRule: PermissionRule = { tool: "my_*", action: "reject", message: "Glob block" };
			const decisions = ["my_tool", "my_custom", "my_"].map((t) =>
				evaluatePermission(t, {}, { userRules: [globRule], interactive: false }),
			);
			for (const d of decisions) {
				expect(d.permitted).toBe(false);
			}
		});

		it("matches regex patterns in tool names", () => {
			const regexRule: PermissionRule = { tool: "/^secret_.*/", action: "reject", message: "Secret tools" };
			const decision = evaluatePermission("secret_api", {}, { userRules: [regexRule], interactive: false });
			expect(decision.permitted).toBe(false);

			// No match for public tool, falls through to default deny (non-interactive)
			const decision2 = evaluatePermission("public_api", {}, { userRules: [regexRule], interactive: false });
			expect(decision2.permitted).toBe(false);
		});

		it("matches nested input properties with regex patterns", () => {
			const rule: PermissionRule = {
				tool: "bash",
				action: "reject",
				matches: { command: "/rm/" },
				message: "Substring rm reject",
			};
			const decision = evaluatePermission(
				"bash",
				{ command: "rm file.txt" },
				{ userRules: [rule], interactive: false },
			);
			expect(decision.permitted).toBe(false);
		});

		it("matches nested input with regex pattern", () => {
			const rule: PermissionRule = {
				tool: "bash",
				action: "reject",
				matches: { command: "/^rm\\s/" },
				message: "Regex rm",
			};
			const decision = evaluatePermission(
				"bash",
				{ command: "rm -rf foo" },
				{ userRules: [rule], interactive: false },
			);
			expect(decision.permitted).toBe(false);

			// No match for ls, falls through to catch-all bash allow
			const decision2 = evaluatePermission("bash", { command: "ls -la" }, { userRules: [rule], interactive: false });
			expect(decision2.permitted).toBe(true);
		});

		it("first matching rule wins", () => {
			const userRules: PermissionRule[] = [
				{ tool: "bash", matches: { command: "/rm/" }, action: "reject", message: "No rm" },
				{ tool: "bash", action: "allow" },
			];
			const decision = evaluatePermission("bash", { command: "rm file" }, { userRules });
			expect(decision.permitted).toBe(false);
			expect(decision.matchIndex).toBe(0);

			const decision2 = evaluatePermission("bash", { command: "ls" }, { userRules });
			expect(decision2.permitted).toBe(true);
			expect(decision2.matchIndex).toBe(1);
		});

		it("treats ask as reject with an actionable message", () => {
			const userRules: PermissionRule[] = [
				{ tool: "dangerous", action: "ask", message: "Confirm with the user first" },
			];
			const decision = evaluatePermission("dangerous", {}, { userRules, interactive: false });
			expect(decision.permitted).toBe(false);
			expect(decision.action).toBe("ask");
			expect(decision.reason).toContain("Confirm");
		});

		it("treats delegate as unsupported", () => {
			const userRules: PermissionRule[] = [{ tool: "legacy", action: "delegate", to: "external" }];
			const decision = evaluatePermission("legacy", {}, { userRules, interactive: false });
			expect(decision.permitted).toBe(false);
			expect(decision.action).toBe("delegate");
			expect(decision.reason).toContain("not supported");
		});

		// --- Role policy threading ---

		it("applies role policy rules when roleId and rolePolicyRules are provided", () => {
			const rolePolicy: PermissionRule[] = [{ tool: "write", action: "reject", message: "Writes blocked by role" }];
			const decision = evaluatePermission(
				"write",
				{ path: "/tmp/foo.ts" },
				{ roleId: "worker", rolePolicyRules: rolePolicy, interactive: false },
			);
			expect(decision.permitted).toBe(false);
			expect(decision.source).toBe("role");
			expect(decision.reason).toContain("role");
		});

		it("role policy source is 'role' when matched", () => {
			const rolePolicy: PermissionRule[] = [{ tool: "bash", action: "reject", message: "Bash blocked by role" }];
			const decision = evaluatePermission(
				"bash",
				{ command: "ls" },
				{ roleId: "worker", rolePolicyRules: rolePolicy, interactive: false },
			);
			expect(decision.permitted).toBe(false);
			expect(decision.source).toBe("role");
		});

		it("backward compat: no roleId skips role policy entirely", () => {
			const rolePolicy: PermissionRule[] = [{ tool: "write", action: "reject", message: "Should not apply" }];
			// No roleId: role policy is skipped, falls through to built-in allow for write
			const decision = evaluatePermission(
				"write",
				{ path: "/tmp/foo.ts" },
				{ rolePolicyRules: rolePolicy, interactive: false },
			);
			expect(decision.permitted).toBe(true);
			expect(decision.source).toBe("built-in");
		});

		it("backward compat: no rolePolicyRules skips role policy even with roleId", () => {
			// roleId set but no rolePolicyRules: role policy is skipped
			const decision = evaluatePermission(
				"write",
				{ path: "/tmp/foo.ts" },
				{ roleId: "worker", interactive: false },
			);
			expect(decision.permitted).toBe(true);
			expect(decision.source).toBe("built-in");
		});

		it("user rules take precedence over role policy rules", () => {
			const userRules: PermissionRule[] = [{ tool: "write", action: "allow", message: "Admin override" }];
			const rolePolicy: PermissionRule[] = [{ tool: "write", action: "reject", message: "Role denies write" }];
			const decision = evaluatePermission(
				"write",
				{ path: "/tmp/foo.ts" },
				{ userRules, roleId: "worker", rolePolicyRules: rolePolicy, interactive: false },
			);
			expect(decision.permitted).toBe(true);
			expect(decision.source).toBe("user");
		});
	});
});
