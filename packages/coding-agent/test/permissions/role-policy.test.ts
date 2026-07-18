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

	it("does not generate static write/edit/edit-diff deny rules (enforced dynamically in the gate)", () => {
		const cwd = "/var/home/user/project";
		const rules = getRolePolicyRules(undefined, cwd);
		const denyWrite = rules.filter((r) => r.action === "reject" && ["write", "edit", "edit-diff"].includes(r.tool));
		expect(denyWrite.length).toBe(0);
	});

	it("includes deny rules for mass-destructive rm targeting ~/.piki", () => {
		const rules = getRolePolicyRules();
		const bashDenyRules = rules.filter((r) => r.tool === "/^(bash|shell)$/" && r.action === "reject");
		expect(bashDenyRules.length).toBeGreaterThanOrEqual(2);
	});

	it("includes write deny rules even without cwd (uses default allowed paths)", () => {
		const rules = getRolePolicyRules(undefined);
		const writeDeny = rules.filter((r) => r.tool === "write" && r.action === "reject");
		// Without cwd, no write-path deny rules are generated.
		expect(writeDeny.length).toBe(0);
	});

	it("does not generate static write deny rules when cwd is provided (enforced dynamically in the gate)", () => {
		const rules = getRolePolicyRules("worker", "/tmp/project");
		const writeDeny = rules.filter((r) => r.tool === "write" && r.action === "reject");
		expect(writeDeny.length).toBe(0);
	});

	it("accepts optional scratchpadPath parameter without generating static write rules", () => {
		const rules = getRolePolicyRules("worker", "/tmp/project", "/tmp/scratchpad");
		expect(rules.length).toBeGreaterThan(0);
		// Write boundaries are enforced dynamically in the gate, not via static
		// scratchpad-path matches, so no static write rule references it.
		expect(rules.some((rule) => rule.tool === "write" && rule.matches?.path?.includes("scratchpad"))).toBe(false);
	});

	describe("disableCwdSafeguards", () => {
		it("skips out-of-cwd write rules when set", () => {
			const rules = getRolePolicyRules("worker", "/tmp/project", undefined, {
				disableCwdSafeguards: true,
			});
			const writeDeny = rules.filter(
				(r) => r.action === "reject" && ["write", "edit", "edit-diff"].includes(r.tool),
			);
			expect(writeDeny.length).toBe(0);
		});

		it("does not include static out-of-cwd write rules (enforced dynamically in the gate)", () => {
			const rules = getRolePolicyRules("worker", "/tmp/project", undefined);
			const writeDeny = rules.filter(
				(r) => r.action === "reject" && ["write", "edit", "edit-diff"].includes(r.tool),
			);
			expect(writeDeny.length).toBe(0);
		});
	});

	describe("disableShellSafeguards", () => {
		it("skips ~/.piki mass-destructive rm rules when set", () => {
			const rules = getRolePolicyRules("worker", "/tmp/project", undefined, {
				disableShellSafeguards: true,
			});
			const pikiDeny = rules.filter(
				(r) => r.tool === "/^(bash|shell)$/" && r.action === "reject" && r.matches?.command?.includes(".piki"),
			);
			expect(pikiDeny.length).toBe(0);
		});

		it("includes ~/.piki mass-destructive rm rules by default", () => {
			const rules = getRolePolicyRules("worker", "/tmp/project", undefined);
			const pikiDeny = rules.filter(
				(r) => r.tool === "/^(bash|shell)$/" && r.action === "reject" && r.matches?.command?.includes(".piki"),
			);
			expect(pikiDeny.length).toBeGreaterThanOrEqual(2);
		});
	});
});
