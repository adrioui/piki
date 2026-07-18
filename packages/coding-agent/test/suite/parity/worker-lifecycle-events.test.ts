import { describe, expect, it, vi } from "vitest";
import { ForkRuntime, type PublishFn } from "../../../src/core/fork-runtime.ts";

/**
 * Parity probe (scientist wave2 — prompts/roles/extensions/skills/worker-lifecycle/signals).
 *
 * Documents the EXACT event vocabulary piki's ForkRuntime publishes for the
 * worker lifecycle (spawn / message / kill / reassign) and asserts it against
 * the Magnitude alpha22 event-core names.
 *
 * Finding: piki uses its own event-core vocabulary, which diverges in event
 * NAMES from mag alpha22 (verified in magnitude-alpha22.embedded.js):
 *   - spawn  : piki `agent_created` + `fork_created`      | mag `agent_created` + `task_assigned`
 *   - kill   : piki `agent_finished{killed}` + `worker_killed` | mag `agent_killed` (+ `task_assigned`)
 *   - reassign: piki `task.assigned`                      | mag `agent_task_changed`
 *   - message: piki `worker_messaged`                     | mag bus `message_start`/`message_chunk`/`message_end`
 *
 * Behavioral contract (spawn->fork, kill->kill session, reassign->rebind,
 * message->deliver) is implemented; only the event NAMES differ. Recorded here
 * so any future rename to match mag's vocabulary is verifiable.
 */

function makeRuntime() {
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const publish: PublishFn = async (type, payload) => {
		events.push({ type, payload: { ...payload } });
	};
	const rt = new ForkRuntime({
		sessionId: "session-root",
		publish,
		getSequence: () => events.length,
	});
	return { rt, events };
}

describe("worker lifecycle event vocabulary (piki ForkRuntime)", () => {
	it("spawn_worker publishes agent_created (+fork_created), not mag's task_assigned", async () => {
		const { rt, events } = makeRuntime();
		await rt.spawnWorker({ role: "engineer", message: "do it", taskId: "t1", agentId: "w1" });
		const types = events.map((e) => e.type);
		expect(types).toContain("agent_created");
		expect(types).toContain("fork_created");
		expect(types).not.toContain("task_assigned");
		expect(types).not.toContain("agent_killed");
	});

	it("kill_worker publishes agent_finished{killed} + worker_killed, not mag's agent_killed", async () => {
		const { rt, events } = makeRuntime();
		await rt.spawnWorker({ role: "engineer", taskId: "t1", agentId: "w1" });
		events.length = 0;
		await rt.killWorker({ workerId: "w1", reason: "done" });
		const types = events.map((e) => e.type);
		expect(types).toContain("worker_killed");
		const finished = events.find((e) => e.type === "agent_finished");
		expect(finished?.payload.killed).toBe(true);
		expect(types).not.toContain("agent_killed");
	});

	it("reassign_worker publishes task.assigned, not mag's agent_task_changed", async () => {
		const { rt, events } = makeRuntime();
		await rt.spawnWorker({ role: "engineer", taskId: "t1", agentId: "w1" });
		events.length = 0;
		await rt.reassignWorker({ taskId: "t1", workerId: "w2" });
		const types = events.map((e) => e.type);
		expect(types).toContain("task.assigned");
		expect(types).not.toContain("agent_task_changed");
		// Reassign must NOT kill the prior worker's session (identity preserved).
		expect(types).not.toContain("agent_finished");
		expect(types).not.toContain("worker_killed");
	});

	it("message_worker publishes worker_messaged carrying workerId + message", async () => {
		const { rt, events } = makeRuntime();
		await rt.spawnWorker({ role: "engineer", taskId: "t1", agentId: "w1" });
		events.length = 0;
		await rt.messageWorker({ workerId: "w1", message: "check this" });
		const msg = events.find((e) => e.type === "worker_messaged");
		expect(msg).toBeDefined();
		expect(msg?.payload.workerId).toBe("w1");
		expect(msg?.payload.message).toBe("check this");
	});

	it("rejects spawn for non-spawnable role (alpha22 contract)", async () => {
		const { rt } = makeRuntime();
		await expect(rt.spawnWorker({ role: "advisor", taskId: "t1", agentId: "w1" })).rejects.toThrow(/not spawnable/);
	});
});

void vi;
