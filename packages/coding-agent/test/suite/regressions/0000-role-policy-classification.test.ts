/**
 * Scientist wave-22 — prompts/roles/workers/skills/extensions parity probes.
 *
 * Pins observable piki behavior against Magnitude alpha22
 * (magnitude-alpha22.embedded.js) for worker system-prompt fidelity and the
 * role-policy classification surface. Deterministic; no network/e2e.
 *
 * Only the public `@piki/roles` export (renderWorkerSystemPrompt) is used here;
 * the ROLE_POLICIES classification and lifecycle-hook text probes live in
 * packages/skills and the suite parity tests to avoid touching private paths.
 *
 * mag reference points:
 *  - worker prompt `WORKER_BASE` (80893) and THINKING_SHARED (80981) are the
 *    canonical shared text; rendered with {{THINKING_LIMIT}} and {{SKILLS_SECTION}}.
 *  - roles carry `lifecycle:{ coordinatorOnSpawn?, coordinatorOnIdle? }`
 *    (81585-82099); spawnable set identical: scout/architect/engineer/critic/
 *    scientist/artisan.
 */

import { renderWorkerSystemPrompt } from "@piki/roles";
import { describe, expect, it } from "vitest";

describe("SCI-W22 worker system-prompt fidelity", () => {
	it("injects THINKING_LIMIT token (mag 113385 THINKING_LIMIT = maxThoughtChars)", () => {
		const prompt = renderWorkerSystemPrompt("scout", { thinkingLimit: 2000 });
		expect(prompt).toContain("limited to 2000 characters");
		expect(prompt).not.toContain("{{THINKING_LIMIT}}");
	});

	it("injects SKILLS_SECTION and resolves to empty when none given", () => {
		const prompt = renderWorkerSystemPrompt("engineer", { skills: "", thinkingLimit: 20000 });
		expect(prompt).not.toContain("{{SKILLS_SECTION}}");
	});

	it("worker base text mentions the shared scratchpad $M contract (mag WORKER_BASE 80893)", () => {
		const prompt = renderWorkerSystemPrompt("critic", { thinkingLimit: 20000 });
		expect(prompt).toContain("You are a worker agent, operating under the direction of the Leader");
		expect(prompt).toContain("$M");
		expect(prompt).toContain("results/ - truncated tool results go here automatically");
	});

	it("does not leave literal template placeholders in rendered prompt", () => {
		const prompt = renderWorkerSystemPrompt("scientist", { thinkingLimit: 20000 });
		expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
	});

	it("appends cwd + current date when cwd provided (mag worker context block)", () => {
		const prompt = renderWorkerSystemPrompt("architect", { thinkingLimit: 20000, cwd: "/tmp/proj" });
		expect(prompt).toContain("Current working directory: /tmp/proj");
		expect(prompt).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
	});
});
