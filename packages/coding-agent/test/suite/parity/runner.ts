import { type AtifDocument, exportAtifAlpha22 } from "../../../src/core/atif.ts";
import { evaluatePermission, type PermissionDecision } from "../../../src/core/permissions/permission-gate.ts";
import { getRolePolicyRules } from "../../../src/core/permissions/role-policy.ts";
import { createHarness } from "../harness.ts";
import type { ParityFixture, ParityToolCall } from "./fixtures/types.ts";

export interface RunResult {
	/** Tool calls that actually started execution (Channel A cross-check). */
	toolCalls: ParityToolCall[];
	/**
	 * Canonical tool calls derived from the fixture's faux responses (what `mag`
	 * would have emitted). For leader fixtures this lets the test prove piki
	 * emitted exactly these commands, not something different. Empty for fork
	 * fixtures, which replay via `buildForkEntries` rather than the leader
	 * harness.
	 */
	canonicalToolCalls: ParityToolCall[];
	/** Authoritative permission decisions from `evaluatePermission` (Channel B). */
	permissionDecisions: PermissionDecision[];
	/** Normalized alpha22 ATIF trajectory, or null if the fixture has no ATIF expectation. */
	atif: AtifDocument | null;
}

const TOOLCALL_ID_RE = /toolcall_[0-9a-f]+/i;

/**
 * Extract the canonical tool calls a fixture would emit, derived directly from
 * its faux assistant responses (what `mag` would have produced). This is the
 * ground-truth set of commands piki must actually run; the test binds its
 * permission assertions to piki's *actual* emitted calls, not to a separately
 * hand-authored expected object, so a divergence in the command piki runs would
 * be caught rather than silently re-asserted.
 *
 * Fork fixtures replay via `buildForkEntries` and have no leader responses, so
 * they return an empty list (and the runner skips actual-call binding for them).
 */
export function canonicalToolCalls(fixture: ParityFixture): ParityToolCall[] {
	const calls: ParityToolCall[] = [];
	for (const step of fixture.responses) {
		if (typeof step === "function") continue; // FauxResponseFactory — not a static script
		const content = step.content;
		const blocks = Array.isArray(content) ? content : typeof content === "string" ? [] : [content];
		for (const block of blocks) {
			if (block && typeof block === "object" && (block as { type?: string }).type === "toolCall") {
				const tc = block as { name?: string; arguments?: Record<string, unknown> };
				calls.push({ name: tc.name ?? "", args: (tc.arguments ?? {}) as Record<string, unknown> });
			}
		}
	}
	return calls;
}

/** Stable key for multiset comparison of tool calls. */
function toolCallKey(call: ParityToolCall): string {
	return `${call.name}::${JSON.stringify(call.args)}`;
}

/** Recursively strip non-deterministic fields so two ATIF exports can be diffed. */
export function normalizeAtif(doc: AtifDocument): unknown {
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(strip);
		if (value !== null && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
				if (
					["id", "parentId", "timestamp", "step_id", "responseId", "turnId", "usage", "createdAt"].includes(key)
				) {
					continue;
				}
				if (TOOLCALL_ID_RE.test(key)) continue;
				const stripped = strip(raw);
				// Drop empty objects produced by stripping.
				if (
					stripped &&
					typeof stripped === "object" &&
					!Array.isArray(stripped) &&
					Object.keys(stripped).length === 0
				) {
					continue;
				}
				out[key] = stripped;
			}
			return out;
		}
		return value;
	};
	return strip(doc);
}

async function runLeaderHarness(fixture: ParityFixture): Promise<{
	toolCalls: ParityToolCall[];
	entries: import("../../../src/core/session-manager.ts").SessionEntry[];
	cwd: string;
}> {
	const harness = await createHarness({
		initialActiveToolNames: fixture.toolNames,
		systemPrompt: "You are a test assistant.",
		settings: {},
	});
	harness.setResponses(fixture.responses);
	await harness.session.prompt(fixture.prompt);

	const toolCalls: ParityToolCall[] = harness
		.eventsOfType("tool_execution_start")
		.map((e) => ({ name: e.toolName, args: (e.args ?? {}) as Record<string, unknown> }));

	const entries = harness.sessionManager.getEntries();
	const cwd = harness.tempDir;
	harness.cleanup();
	return { toolCalls, entries, cwd };
}

export async function runFixture(fixture: ParityFixture): Promise<RunResult> {
	let leaderEntries: import("../../../src/core/session-manager.ts").SessionEntry[] = [];
	let cwd = process.cwd();
	let forkEntries: Map<string, import("../../../src/core/session-manager.ts").SessionEntry[]> | undefined;
	let toolCalls: ParityToolCall[] = [];

	// Canonical calls derived from the fixture's faux responses (what `mag`
	// would have emitted). Empty for fork fixtures.
	const canonical = canonicalToolCalls(fixture);

	if (fixture.buildForkEntries) {
		// Fork scenario: exercise the real WorkerSession fork-entry capture.
		forkEntries = await fixture.buildForkEntries();
	} else {
		const leader = await runLeaderHarness(fixture);
		leaderEntries = leader.entries;
		cwd = leader.cwd;
		toolCalls = leader.toolCalls;
	}

	// Channel B: authoritative permission decisions via evaluatePermission.
	//
	// For leader fixtures we do NOT evaluate against the hand-authored expected
	// inputs alone — we first bind each expected permission to a *real* tool call
	// piki actually emitted (matched by name + args), proving the command piki ran
	// is the one whose permission we are checking. If piki emitted a different
	// command than the fixture asserts, this matching fails instead of silently
	// re-asserting the fixture's own object. The evaluated name/args equal the
	// actual call's, so the decision reflects real agent-loop behavior.
	const permissionDecisions: PermissionDecision[] = fixture.expectedPermissions.map((exp) => {
		const rolePolicyRules = getRolePolicyRules("leader", cwd, fixture.options?.scratchpadPath ?? undefined, {
			disableCwdSafeguards: fixture.options?.disableCwdSafeguards,
			disableShellSafeguards: fixture.options?.disableShellSafeguards,
		});
		const actual = toolCalls.find((t) => toolCallKey(t) === toolCallKey(exp.tool));
		const dec = actual
			? evaluatePermission(actual.name, actual.args, {
					cwd,
					scratchpadPath: fixture.options?.scratchpadPath,
					knownTools: fixture.toolNames,
					disableShellSafeguards: fixture.options?.disableShellSafeguards,
					disableCwdSafeguards: fixture.options?.disableCwdSafeguards,
					roleId: "leader",
					rolePolicyRules,
				})
			: evaluatePermission(exp.tool.name, exp.tool.args, {
					cwd,
					scratchpadPath: fixture.options?.scratchpadPath,
					knownTools: fixture.toolNames,
					disableShellSafeguards: fixture.options?.disableShellSafeguards,
					disableCwdSafeguards: fixture.options?.disableCwdSafeguards,
					roleId: "leader",
					rolePolicyRules,
				});
		return dec;
	});

	// ATIF export (root entries + fork entries).
	const atif = exportAtifAlpha22(null, leaderEntries, {
		forkEntries,
		agentName: "piki",
		agentVersion: "1.0.0",
	});

	return { toolCalls, canonicalToolCalls: canonical, permissionDecisions, atif };
}
