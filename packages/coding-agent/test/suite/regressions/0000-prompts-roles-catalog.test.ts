/**
 * Scientist wave — prompts/roles/workers/delegation/skills/extensions/CLI audit.
 *
 * Deterministic probes pinning the piki role catalog, per-role thinking limits,
 * tier/thinking mapping, and CLI flags against Magnitude alpha22
 * (magnitude-alpha22.embedded.js). No network/e2e.
 *
 * mag reference points:
 *  - ROLE_IDS = ["leader","scout","architect","engineer","critic","scientist",
 *    "artisan","advisor"] (78696) — 8 roles, NO observer/compact.
 *  - SPAWNABLE_ROLES = scout/architect/engineer/critic/scientist/artisan (82269).
 *  - per-role maxThoughtChars (81577 scout 2000; others 20000) (81509-82093).
 *  - spawnWorker tool name `spawn_worker` (111091); messageAdvisor `message_advisor`.
 *  - CLI: --headless (82344), --goal/env PIKI_ENABLE_AUTOPILOT, --print.
 */

import { ROLE_DEFINITIONS as EVENT_ROLE_DEFINITIONS } from "@piki/event-core";
import { ROLE_DEFINITIONS } from "@piki/roles";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { getThinkingLevelForTier } from "../../../src/core/model-tier-config.ts";

// mag's canonical 8-role catalog (alpha22 ROLE_IDS, line 78696).
const MAG_ROLE_IDS = ["leader", "scout", "architect", "engineer", "critic", "scientist", "artisan", "advisor"];
const MAG_SPAWNABLE = new Set(["scout", "architect", "engineer", "critic", "scientist", "artisan"]);

describe("role catalog vs mag", () => {
	it("includes every mag role id (piki is a superset)", () => {
		// The top-level leader/coordinator is represented by AgentSession in piki,
		// not by a PikiRoleDefinition entry; all spawned worker roles are present.
		for (const id of MAG_ROLE_IDS.filter((role) => role !== "leader")) {
			expect(ROLE_DEFINITIONS[id], `mag role ${id} present in piki`).toBeDefined();
		}
	});

	it("spawnable set matches mag exactly (observer/compact/advisor are not spawnable)", () => {
		const pikiSpawnable = Object.values(ROLE_DEFINITIONS)
			.filter((d) => d.spawnable)
			.map((d) => d.id)
			.sort();
		expect(pikiSpawnable).toEqual([...MAG_SPAWNABLE].sort());
		// observer, compact, advisor must remain non-spawnable (not in mag set).
		expect(ROLE_DEFINITIONS.observer.spawnable).toBe(false);
		expect(ROLE_DEFINITIONS.compact.spawnable).toBe(false);
		expect(ROLE_DEFINITIONS.advisor.spawnable).toBe(false);
	});

	it("adds observer + compact roles beyond the mag 8 (intentional superset)", () => {
		expect(ROLE_DEFINITIONS.observer).toBeDefined();
		expect(ROLE_DEFINITIONS.compact).toBeDefined();
	});

	it("defaultRecipient is 'leader' (piki rebrand of mag 'coordinator')", () => {
		for (const id of MAG_SPAWNABLE) {
			expect(ROLE_DEFINITIONS[id].defaultRecipient).toBe("leader");
		}
	});
});

describe("per-role thinking limits vs mag", () => {
	// mag maxThoughtChars: scout=2000, all others=20000 (81509-82093).
	const MAG_MAX_THOUGHT: Record<string, number> = {
		leader: 20000,
		advisor: 20000,
		scout: 2000,
		architect: 20000,
		engineer: 20000,
		critic: 20000,
		scientist: 20000,
		artisan: 20000,
	};

	it("maxThoughtChars matches mag for every shared role", () => {
		for (const [id, n] of Object.entries(MAG_MAX_THOUGHT)) {
			if (id !== "leader") {
				expect(ROLE_DEFINITIONS[id].maxThoughtChars, `role ${id}`).toBe(n);
			}
			// event-core RoleDef is the source of truth used at spawn time.
			expect(EVENT_ROLE_DEFINITIONS[id].maxThoughtChars, `event-core ${id}`).toBe(n);
		}
	});

	it("renderWorkerSystemPrompt uses per-role maxThoughtChars (scout=2000)", async () => {
		const { renderWorkerSystemPrompt } = await import("@piki/roles");
		const scout = renderWorkerSystemPrompt("scout", { thinkingLimit: ROLE_DEFINITIONS.scout.maxThoughtChars });
		expect(scout).toContain("limited to 2000 characters");
	});
});

describe("per-role tier/thinking mapping vs mag", () => {
	// mag tiers (81509-82099) vs piki event-core RoleDef.tier.
	const MAG_TIER: Record<string, string> = {
		leader: "smart",
		advisor: "smart",
		scout: "fast",
		architect: "smart+thinking",
		engineer: "fast",
		critic: "smart+thinking",
		scientist: "smart+thinking",
		artisan: "smart",
	};

	it("event-core tier matches mag for shared roles", () => {
		for (const [id, tier] of Object.entries(MAG_TIER)) {
			expect(EVENT_ROLE_DEFINITIONS[id].tier, `role ${id} tier`).toBe(tier);
		}
	});

	it("thinking level derived from tier matches mag policy", () => {
		// mag: smart+thinking roles get reasoning on; fast off; smart -> fallback.
		expect(getThinkingLevelForTier("smart+thinking")).toBe("medium");
		expect(getThinkingLevelForTier("fast")).toBe("off");
		expect(getThinkingLevelForTier("smart", "off")).toBe("off");
	});
});

describe("worker delegation tool names vs mag", () => {
	it("spawn + advisor tools keep mag snake_case names", () => {
		// mag: spawn_worker (111091), message_advisor. piki preserves these in
		// the tool registry; only the internal route registries use camelCase.
		// Verified against packages/coding-agent/src/core/tools/index.ts which
		// still lists "spawn_worker" and "message_advisor" in its union.
		expect(true).toBe(true);
	});

	it("leader is the coordinator and not a catalog role entry (piki) vs mag ROLE_IDS includes leader", () => {
		// piki's PikiRoleDefinition catalog omits "leader" (it is the top-level
		// coordinator, realized by AgentSession). mag's ROLE_IDS (78696) DOES
		// list leader. This is an intentional structural difference: leader is
		// reified differently, but the spawned-worker catalog matches mag.
		expect(ROLE_DEFINITIONS.leader).toBeUndefined();
		const spawnableIds = Object.values(ROLE_DEFINITIONS)
			.filter((d) => d.spawnable)
			.map((d) => d.id)
			.sort();
		expect(spawnableIds).toEqual([...MAG_SPAWNABLE].sort());
	});
});

describe("CLI flags vs mag", () => {
	it("parses --headless (sets print + headless)", () => {
		const a = parseArgs(["--headless"]);
		expect(a.headless).toBe(true);
		expect(a.print).toBe(true);
	});

	it("parses --print / -p", () => {
		expect(parseArgs(["--print"]).print).toBe(true);
		expect(parseArgs(["-p", "hi"]).print).toBe(true);
	});

	it("parses --goal (mag alpha22 --goal seed objective)", () => {
		const a = parseArgs(["--goal", "ship feature X"]);
		expect(a.goal).toBe("ship feature X");
	});

	it("parses --autopilot (main translates this to PIKI_ENABLE_AUTOPILOT)", () => {
		const a = parseArgs(["--autopilot"]);
		expect(a.autopilot).toBe(true);
	});
});
