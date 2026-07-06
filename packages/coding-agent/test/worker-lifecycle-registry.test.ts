import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { WorkerLifecycleRegistry } from "../src/core/worker-lifecycle-registry.ts";

describe("WorkerLifecycleRegistry", () => {
	it("applies declarative lifecycle actions and indexes records by fork", async () => {
		const registry = new WorkerLifecycleRegistry();

		await Effect.runPromise(registry.apply({ type: "created", forkId: "fork-1", agentId: "agent-1", role: "scout" }));
		await Effect.runPromise(registry.apply({ type: "started", agentId: "agent-1" }));
		await Effect.runPromise(registry.apply({ type: "messaged", agentId: "agent-1" }));
		await Effect.runPromise(
			registry.apply({ type: "finished", agentId: "agent-1", status: "killed", reason: "test" }),
		);

		expect(registry.get("agent-1")).toMatchObject({
			agentId: "agent-1",
			forkId: "fork-1",
			role: "scout",
			status: "killed",
			cleanupReason: "test",
		});
		expect(registry.getByFork("fork-1")).toHaveLength(1);

		await Effect.runPromise(registry.apply({ type: "cleaned", agentId: "agent-1", reason: "cleanup" }));

		expect(registry.get("agent-1")?.status).toBe("cleaned");
		expect(registry.getByFork("fork-1")).toHaveLength(0);
	});
});
