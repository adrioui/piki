import { describe, expect, it } from "vitest";
import { forkScenarioFixture } from "./fixtures/fork-scenario.ts";
import { gitMutationFixture } from "./fixtures/git-mutation.ts";
import { leaderWriteBoundaryDisabledFixture, leaderWriteBoundaryFixture } from "./fixtures/leader-write-boundary.ts";
import { readEditFixture } from "./fixtures/read-edit.ts";
import { shellBoundaryFixture } from "./fixtures/shell-boundary.ts";
import type { ParityAtifExpectation, ParityFixture } from "./fixtures/types.ts";
import { normalizeAtif, runFixture } from "./runner.ts";

const fixtures: ParityFixture[] = [
	shellBoundaryFixture,
	readEditFixture,
	forkScenarioFixture,
	leaderWriteBoundaryFixture,
	leaderWriteBoundaryDisabledFixture,
	gitMutationFixture,
];

function assertAtif(atif: import("./runner.ts").RunResult["atif"], exp: ParityAtifExpectation): void {
	expect(atif).not.toBeNull();
	const doc = atif as NonNullable<typeof atif>;
	const normalized = normalizeAtif(doc) as {
		steps: Array<{
			source?: string;
			extra?: Record<string, unknown>;
			tool_calls?: unknown[];
			llm_call_count?: number;
		}>;
		final_metrics?: { total_steps: number };
		subagent_trajectories: Array<{
			steps: Array<{
				source?: string;
				extra?: Record<string, unknown>;
				tool_calls?: unknown[];
				llm_call_count?: number;
			}>;
		}>;
	};

	// Collect steps from root trajectory AND every subagent trajectory.
	const allSteps = [...normalized.steps, ...normalized.subagent_trajectories.flatMap((t) => t.steps)];

	if (exp.stepTypes) {
		expect(normalized.steps.map((s) => s.source)).toEqual(exp.stepTypes);
	}
	if (exp.totalSteps !== undefined) {
		expect(doc.final_metrics.total_steps).toBe(exp.totalSteps);
	}
	if (exp.subagentTrajectoryCount !== undefined) {
		expect(doc.subagent_trajectories.length).toBe(exp.subagentTrajectoryCount);
	}
	if (exp.forkIdPresent === true) {
		const userAndAgent = allSteps.filter((s) => s.source === "user" || s.source === "agent");
		expect(userAndAgent.length).toBeGreaterThan(0);
		for (const step of userAndAgent) {
			expect(step.extra?.forkId).not.toBeNull();
			expect(step.extra?.forkId).toBeDefined();
		}
	}
	if (exp.llmCallCountPresent === true) {
		const has = allSteps.some((s) => typeof s.llm_call_count === "number");
		expect(has).toBe(true);
	}
	if (exp.hasAssistantWithToolCalls === true) {
		const has = allSteps.some((s) => Array.isArray(s.tool_calls) && s.tool_calls.length > 0);
		expect(has).toBe(true);
	}
}

describe("piki vs mag deterministic parity", () => {
	for (const fixture of fixtures) {
		it(`parity: ${fixture.id} — ${fixture.description}`, async () => {
			const result = await runFixture(fixture);

			// Channel B (authoritative): every expected permission decision.
			expect(result.permissionDecisions.length).toBe(fixture.expectedPermissions.length);
			for (let i = 0; i < fixture.expectedPermissions.length; i++) {
				const exp = fixture.expectedPermissions[i]!;
				const dec = result.permissionDecisions[i]!;
				expect(dec.permitted, `tool ${exp.tool.name} permitted`).toBe(exp.permitted);
				if (!exp.permitted) {
					expect(dec.reason, `tool ${exp.tool.name} reason`).toBe(exp.reason);
				}
			}

			// Channel A (actual-args binding): for leader fixtures, prove piki
			// emitted exactly the canonical commands — including the DENIED
			// /etc write. `tool_execution_start` fires for denied bash attempts
			// too, so the actual call set must equal the canonical set (by
			// name + args). This catches any divergence between what the fixture
			// asserts and what piki actually ran, rather than re-asserting the
			// fixture's own object. Channel B (evaluatePermission) remains the
			// authoritative permission channel, but it now evaluates the ACTUAL
			// emitted calls (see runner.ts), so the /etc rejection is proven
			// against the exact command piki emitted.
			// Skipped for fork fixtures, which replay via buildForkEntries and
			// have no leader tool_execution_start events.
			if (!fixture.buildForkEntries) {
				const key = (t: { name: string; args: Record<string, unknown> }): string =>
					`${t.name}::${JSON.stringify(t.args)}`;
				const actual = result.toolCalls.map(key).sort();
				const expected = result.canonicalToolCalls.map(key).sort();
				expect(actual, "actual emitted tool calls match canonical fixture responses").toEqual(expected);
			}

			// ATIF shape parity (S5/S7/S8 + step counting).
			if (fixture.expectedAtif) {
				assertAtif(result.atif, fixture.expectedAtif);
			}
		});
	}
});
