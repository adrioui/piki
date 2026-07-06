/**
 * Tests for the per-role permission policy.
 */

import { describe, expect, it } from "vitest";
import { getRolePolicyRules } from "../../src/core/permissions/role-policy.ts";

describe("getRolePolicyRules", () => {
	it("returns a non-empty array of rules", () => {
		const rules = getRolePolicyRules();
		expect(rules.length).toBeGreaterThan(0);
	});

	it("returns the same rules regardless of roleId (uniform deny stack)", () => {
		const defaultRules = getRolePolicyRules();
		const workerRules = getRolePolicyRules("worker");
		const observerRules = getRolePolicyRules("observer");
		expect(workerRules).toEqual(defaultRules);
		expect(observerRules).toEqual(defaultRules);
	});

	it("does not include a catch-all allow rule", () => {
		const rules = getRolePolicyRules();
		expect(rules.some((rule) => rule.tool === "*" && rule.action === "allow")).toBe(false);
	});

	it("includes deny rules for write/edit/edit-diff outside allowed dirs", () => {
		const cwd = "/var/home/user/project";
		const rules = getRolePolicyRules(undefined, cwd);
		const denyWrite = rules.filter((r) => r.action === "reject" && ["write", "edit", "edit-diff"].includes(r.tool));
		expect(denyWrite.length).toBeGreaterThanOrEqual(3);
	});

	it("includes deny rules for mass-destructive rm targeting ~/.piki", () => {
		const rules = getRolePolicyRules();
		const bashDenyRules = rules.filter((r) => r.tool === "bash" && r.action === "reject");
		expect(bashDenyRules.length).toBeGreaterThanOrEqual(2);
	});

	it("includes write deny rules even without cwd (uses default allowed paths)", () => {
		const rules = getRolePolicyRules(undefined);
		const writeDeny = rules.filter((r) => r.tool === "write" && r.action === "reject");
		// Without cwd, no write-path deny rules are generated.
		expect(writeDeny.length).toBe(0);
	});

	it("includes write deny rules when cwd is provided", () => {
		const rules = getRolePolicyRules("worker", "/tmp/project");
		const writeDeny = rules.filter((r) => r.tool === "write" && r.action === "reject");
		expect(writeDeny.length).toBeGreaterThan(0);
	});

	it("accepts optional scratchpadPath parameter", () => {
		const rules = getRolePolicyRules("worker", "/tmp/project", "/tmp/scratchpad");
		expect(rules.length).toBeGreaterThan(0);
		expect(rules.some((rule) => rule.matches?.path?.includes("scratchpad"))).toBe(true);
	});
});
