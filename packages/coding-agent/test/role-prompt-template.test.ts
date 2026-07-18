import { definePrompt } from "@piki/roles";
import { describe, expect, it } from "vitest";
import { getPikiRoleDefinition, getRolePolicy, PIKI_ROLE_DEFINITIONS } from "../src/core/roles/definitions.ts";

describe("Piki role prompt templates", () => {
	it("renders {{VAR}} placeholders while preserving unknown placeholders", () => {
		const prompt = definePrompt("Hello {{NAME}} from {{PLACE}} and {{UNKNOWN}}");

		expect(prompt.render({ NAME: "agent", PLACE: "repo" })).toBe("Hello agent from repo and {{UNKNOWN}}");
	});

	it("defines role metadata and renderable worker prompts", () => {
		const engineer = getPikiRoleDefinition("engineer");

		expect(engineer?.agentKind).toBe("worker");
		expect(engineer?.spawnable).toBe(true);
		expect(engineer?.toolkit).toBe("workerBase");
		expect(engineer?.prompt.render()).toContain("# Thinking");
		expect(engineer?.prompt.render()).toContain("# Engineer");
		expect(engineer?.prompt.render()).toContain("## Skills");
		expect(getRolePolicy("engineer")).toMatchObject({ allowMutation: true, requiresVerification: true });
	});

	it("includes observer and compact lifecycle definitions", () => {
		expect(PIKI_ROLE_DEFINITIONS.observer.lifecycle).toEqual({ start: "ambient", stop: "pass" });
		expect(PIKI_ROLE_DEFINITIONS.compact.lifecycle).toEqual({ start: "ambient", stop: "compact" });
		expect(PIKI_ROLE_DEFINITIONS.compact.toolkit).toBe("compactToolkit");
	});
});
