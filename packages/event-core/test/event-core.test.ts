import { describe, expect, it } from "vitest";
import {
	canCompleteTask,
	createChatTitleWorker,
	createCheckpointProjection,
	createContextUsageProjection,
	createConversationProjection,
	createCortexWorker,
	createDisplayWorker,
	createFileMentionResolverWorker,
	createForkProjection,
	createGoalProjection,
	createTaskGraphProjection,
	createUsageProjection,
	DefaultEventSink,
	InMemoryEventStore,
	ProjectionStore,
	RoleHost,
} from "../src/index.ts";
import type { EventEnvelope } from "../src/types.ts";
import { createSignal as createSignalDefinition } from "../src/types.ts";

type TestEvent = EventEnvelope<"counted" | "mirrored", { value: number }>;
type RuntimeEvent = EventEnvelope<string, Record<string, unknown>>;

function event(sequence: number, type: TestEvent["type"], value: number): TestEvent {
	return {
		id: `event-${sequence}`,
		stream: "test",
		sequence,
		type,
		timestamp: new Date(sequence * 1000).toISOString(),
		payload: { value },
	};
}

function runtimeEvent(sequence: number, type: string, payload: Record<string, unknown>): RuntimeEvent {
	return {
		id: `runtime-${sequence}`,
		stream: "session:test",
		sequence,
		type,
		timestamp: new Date(sequence * 1000).toISOString(),
		sessionId: "session-test",
		payload,
	};
}

describe("event-core", () => {
	it("stores and filters events", () => {
		const store = new InMemoryEventStore<TestEvent>();
		store.append(event(1, "counted", 1));
		store.append(event(2, "counted", 2));
		expect(store.list()).toHaveLength(2);
		expect(store.list({ afterSequence: 1 })).toHaveLength(1);
	});

	it("applies projections across events", () => {
		const projections = new ProjectionStore<TestEvent>();
		projections.register({
			name: "sum",
			initialState: 0,
			reduce: (state: number, current) => (current.type === "counted" ? state + current.payload.value : state),
		});
		projections.apply(event(1, "counted", 2));
		projections.apply(event(2, "mirrored", 1));
		projections.apply(event(3, "counted", 3));
		expect(projections.get<number>("sum")).toBe(5);
		expect(projections.getLastSequence("sum")).toBe(3);
	});

	it("runs roles sequentially per concurrency key", async () => {
		const store = new InMemoryEventStore<TestEvent>();
		const projections = new ProjectionStore<TestEvent>();
		projections.register({
			name: "last",
			initialState: 0,
			reduce: (_state: number, current) => current.payload.value,
		});
		const handled: string[] = [];
		const host = new RoleHost<TestEvent>({
			projections,
			publish: async (current) => {
				store.append(current);
				projections.apply(current);
			},
		});
		host.register({
			name: "mirror",
			match: (current) => current.type === "counted",
			concurrencyKey: () => "single",
			run: async ({ event, publish }) => {
				handled.push(event.id);
				await publish({
					...event,
					id: `${event.id}-mirror`,
					type: "mirrored",
					sequence: event.sequence + 100,
				});
			},
		});

		const first = event(1, "counted", 1);
		const second = event(2, "counted", 2);
		projections.apply(first);
		projections.apply(second);
		await Promise.all([host.handle(first), host.handle(second)]);
		await host.waitForIdle();

		expect(handled).toEqual(["event-1", "event-2"]);
		expect(store.list()).toHaveLength(2);
		expect(store.list().map((current) => current.type)).toEqual(["mirrored", "mirrored"]);
	});

	it("assigns unique sequences to role-published events", async () => {
		const store = new InMemoryEventStore<TestEvent>();
		const sink = new DefaultEventSink<TestEvent>(store);
		sink.registerProjection({
			name: "last",
			initialState: 0,
			reduce: (_state: number, current) => current.payload.value,
		});
		sink.registerRole({
			name: "first",
			match: (current) => current.type === "counted",
			run: async ({ event, publish }) => {
				await publish({ ...event, id: "first-derived", type: "mirrored", sequence: event.sequence + 1 });
			},
		});
		sink.registerRole({
			name: "second",
			match: (current) => current.type === "counted",
			run: async ({ event, publish }) => {
				await publish({ ...event, id: "second-derived", type: "mirrored", sequence: event.sequence + 1 });
			},
		});

		await sink.publish(event(1, "counted", 1));
		await sink.waitForIdle();

		expect(store.list().map((current) => current.sequence)).toEqual([1, 2, 3]);
		sink.dispose();
	});

	it("applies ephemeral events without persisting them", async () => {
		const store = new InMemoryEventStore<TestEvent>();
		const sink = new DefaultEventSink<TestEvent>(store);
		sink.registerProjection({
			name: "sum",
			initialState: 0,
			reduce: (state: number, current) => (current.type === "counted" ? state + current.payload.value : state),
		});

		await sink.publish({ ...event(1, "counted", 4), ephemeral: true });
		await sink.waitForIdle();

		expect(store.list()).toEqual([]);
		expect(sink.projections().get<number>("sum")).toBe(4);
		expect(sink.getSequence()).toBe(1);
		sink.dispose();
	});

	it("waitForIdle waits for cascading role publications", async () => {
		const store = new InMemoryEventStore<TestEvent>();
		const sink = new DefaultEventSink<TestEvent>(store);
		let handledCascade = false;
		sink.registerProjection({
			name: "last",
			initialState: 0,
			reduce: (_state: number, current) => current.payload.value,
		});
		sink.registerRole({
			name: "publisher",
			match: (current) => current.type === "counted",
			run: async ({ event, publish }) => {
				await publish({ ...event, id: "cascade", type: "mirrored", sequence: event.sequence + 1 });
			},
		});
		sink.registerRole({
			name: "cascade",
			match: (current) => current.type === "mirrored",
			run: () => {
				handledCascade = true;
			},
		});

		await sink.publish(event(1, "counted", 1));
		await sink.waitForIdle();

		expect(handledCascade).toBe(true);
		sink.dispose();
	});

	it("replays events to hydrate projection state", () => {
		const projections = new ProjectionStore<TestEvent>();
		projections.register({
			name: "sum",
			initialState: () => 0,
			reduce: (state: number, current) => (current.type === "counted" ? state + current.payload.value : state),
		});
		const events = [event(1, "counted", 10), event(2, "counted", 5), event(3, "mirrored", 1)];
		projections.replay(events);
		expect(projections.get<number>("sum")).toBe(15);
		expect(projections.getLastSequence("sum")).toBe(3);
	});

	it("extracts signals from projections", () => {
		type GoalEvent = EventEnvelope<"goal.injected" | "goal.finished", { goal?: string }>;
		const projections = new ProjectionStore<GoalEvent>();
		projections.register(createGoalProjection<GoalEvent>());

		const signals = projections.apply({
			id: "g1",
			stream: "test",
			sequence: 1,
			type: "goal.injected",
			timestamp: new Date().toISOString(),
			payload: { goal: "Write tests" },
		});
		expect(signals).toHaveLength(1);
		expect(signals[0].type).toBe("Goal/injected");
		expect(projections.get<{ goal: string | null; status: string }>("Goal")?.status).toBe("started");
	});

	it("runs GoalProjection through full lifecycle", () => {
		type GoalEvent = EventEnvelope<
			"goal.injected" | "goal.finished" | "goal.incomplete",
			{ goal?: string; evidence?: string; verdict?: string; source?: string }
		>;
		const projections = new ProjectionStore<GoalEvent>();
		projections.register(createGoalProjection<GoalEvent>());

		projections.apply({
			id: "1",
			stream: "s",
			sequence: 1,
			type: "goal.injected",
			timestamp: "t",
			payload: { goal: "Test" },
		});
		expect(projections.get<{ goal: string | null; status: string }>("Goal")?.status).toBe("started");

		projections.apply({
			id: "2",
			stream: "s",
			sequence: 2,
			type: "goal.finished",
			timestamp: "t",
			payload: { evidence: "tests passed", verdict: "done", source: "critic" },
		});
		expect(
			projections.get<{ goal: string | null; status: string; evidence?: string; verdict?: string; source?: string }>(
				"Goal",
			),
		).toMatchObject({
			status: "finished",
			evidence: "tests passed",
			verdict: "done",
			source: "critic",
		});
	});

	it("turn outcomes do not derive goal lifecycle events without verifier payloads", async () => {
		const store = new InMemoryEventStore<RuntimeEvent>();
		const sink = new DefaultEventSink<RuntimeEvent>(store);
		sink.registerProjection(createGoalProjection<RuntimeEvent>());

		await sink.publish(runtimeEvent(1, "goal.injected", { goal: "Ship fix" }));
		await sink.publish(runtimeEvent(2, "turn_outcome", { result: "finished", turnId: "turn-1" }));
		await sink.waitForIdle();

		expect(store.list().map((current) => current.type)).toEqual(["goal.injected", "turn_outcome"]);
		expect(sink.projections().get<{ goal: string | null; status: string }>("Goal")?.status).toBe("started");
		sink.dispose();
	});

	it("manages TaskGraph with parent-child completion rules", () => {
		type TaskEvent = EventEnvelope<"task.created" | "task.status_changed" | "task.assigned", Record<string, unknown>>;
		const projections = new ProjectionStore<TaskEvent>();
		projections.register(createTaskGraphProjection<TaskEvent>());

		projections.apply({
			id: "1",
			stream: "s",
			sequence: 1,
			type: "task.created",
			timestamp: "t",
			payload: { taskId: "root", title: "Root" },
		});
		projections.apply({
			id: "2",
			stream: "s",
			sequence: 2,
			type: "task.created",
			timestamp: "t",
			payload: { taskId: "child", title: "Child", parentId: "root" },
		});

		const state = projections.get<{
			tasks: Map<string, { id: string; status: string; children: string[] }>;
			orderedTaskIds: string[];
		}>("TaskGraph")!;
		expect(state.orderedTaskIds).toEqual(["root", "child"]);
		expect(state.tasks.get("root")?.children).toEqual(["child"]);

		// Cannot complete parent before child
		expect(canCompleteTask({ tasks: state.tasks as any, orderedTaskIds: [], depthByTaskId: new Map() }, "root")).toBe(
			false,
		);

		// Complete child first
		projections.apply({
			id: "3",
			stream: "s",
			sequence: 3,
			type: "task.status_changed",
			timestamp: "t",
			payload: { taskId: "child", status: "completed" },
		});
		const state2 = projections.get<{
			tasks: Map<string, { id: string; status: string; children: string[] }>;
			orderedTaskIds: string[];
		}>("TaskGraph")!;
		expect(
			canCompleteTask({ tasks: state2.tasks as any, orderedTaskIds: [], depthByTaskId: new Map() }, "root"),
		).toBe(true);
	});

	it("does not mutate previous TaskGraph state when adding children", () => {
		type TaskEvent = EventEnvelope<"task.created", Record<string, unknown>>;
		const projections = new ProjectionStore<TaskEvent>();
		projections.register(createTaskGraphProjection<TaskEvent>());

		projections.apply({
			id: "1",
			stream: "s",
			sequence: 1,
			type: "task.created",
			timestamp: "t",
			payload: { taskId: "root", title: "Root" },
		});
		const previousState = projections.get<{ tasks: Map<string, { children: string[] }> }>("TaskGraph")!;
		const previousRoot = previousState.tasks.get("root")!;

		projections.apply({
			id: "2",
			stream: "s",
			sequence: 2,
			type: "task.created",
			timestamp: "t",
			payload: { taskId: "child", title: "Child", parentId: "root" },
		});

		expect(previousRoot.children).toEqual([]);
	});

	it("emits ContextUsage soft-cap signal only on threshold crossing", () => {
		type UsageEvent = EventEnvelope<"usage_recorded" | "other", Record<string, unknown>>;
		const projections = new ProjectionStore<UsageEvent>();
		projections.register(createContextUsageProjection<UsageEvent>());

		const below = projections.apply({
			id: "1",
			stream: "s",
			sequence: 1,
			type: "usage_recorded",
			timestamp: "t",
			payload: { totalTokens: 5, softCap: 10, hardCap: 20 },
		});
		const crossing = projections.apply({
			id: "2",
			stream: "s",
			sequence: 2,
			type: "usage_recorded",
			timestamp: "t",
			payload: { totalTokens: 10, softCap: 10, hardCap: 20 },
		});
		const after = projections.apply({
			id: "3",
			stream: "s",
			sequence: 3,
			type: "other",
			timestamp: "t",
			payload: {},
		});

		expect(below).toEqual([]);
		expect(crossing.map((signal) => signal.type)).toEqual(["ContextUsage/softCapExceeded"]);
		expect(after).toEqual([]);
	});

	it("accumulates usage cache tokens and missing usage reasons", () => {
		type UsageEvent = EventEnvelope<"usage_recorded", Record<string, unknown>>;
		const projections = new ProjectionStore<UsageEvent>();
		projections.register(createUsageProjection<UsageEvent>());

		projections.apply({
			id: "1",
			stream: "s",
			sequence: 1,
			type: "usage_recorded",
			timestamp: "t",
			payload: {
				inputTokens: 3,
				outputTokens: 5,
				cacheReadTokens: 7,
				cacheWriteTokens: 11,
				totalTokens: 26,
				cost: 0.5,
			},
		});
		projections.apply({
			id: "2",
			stream: "s",
			sequence: 2,
			type: "usage_recorded",
			timestamp: "t",
			payload: { inputTokens: 1, outputTokens: 2, missingReason: "usage_chunk_never_arrived" },
		});

		expect(projections.get("Usage")).toEqual({
			inputTokens: 4,
			outputTokens: 7,
			cacheReadTokens: 7,
			cacheWriteTokens: 11,
			totalTokens: 29,
			cost: 0.5,
			missingReason: "usage_chunk_never_arrived",
		});
	});

	it("deduplicates resolved user messages in the conversation projection", async () => {
		const store = new InMemoryEventStore<RuntimeEvent>();
		const sink = new DefaultEventSink<RuntimeEvent>(store);
		sink.registerProjection(createConversationProjection<RuntimeEvent>());
		sink.registerRole(createFileMentionResolverWorker<RuntimeEvent>());

		await sink.publish(runtimeEvent(1, "user_message", { role: "user", text: "Read @README.md" }));
		await sink.waitForIdle();

		const conversation = sink.projections().get<{ messages: Array<{ role: string; text: string }> }>("Conversation")!;
		expect(store.list().map((current) => current.type)).toEqual(["user_message", "user_message_ready"]);
		expect(conversation.messages).toHaveLength(1);
		expect(conversation.messages[0]).toMatchObject({ role: "user", text: "Read @README.md" });
		sink.dispose();
	});

	it("CortexWorker does not publish duplicate turn_started events", async () => {
		const store = new InMemoryEventStore<RuntimeEvent>();
		const sink = new DefaultEventSink<RuntimeEvent>(store);
		sink.registerRole(createCortexWorker<RuntimeEvent>());

		await sink.publish(runtimeEvent(1, "user_message_ready", { role: "user", text: "hello" }));
		await sink.waitForIdle();

		expect(store.list().map((current) => current.type)).toEqual(["user_message_ready"]);
		sink.dispose();
	});

	it("Fork projection evicts entries on fork_cleaned", () => {
		const projections = new ProjectionStore<RuntimeEvent>();
		projections.register(createForkProjection<RuntimeEvent>());

		projections.apply(runtimeEvent(1, "agent_created", { forkId: "fork-1", agentId: "agent-1" }));
		expect(projections.get<{ forks: Map<string, Record<string, unknown>> }>("Fork")?.forks.has("fork-1")).toBe(true);

		projections.apply(runtimeEvent(2, "fork_cleaned", { forkId: "fork-1", agentId: "agent-1" }));
		expect(projections.get<{ forks: Map<string, Record<string, unknown>> }>("Fork")?.forks.has("fork-1")).toBe(false);
	});

	it("generates chat titles only for explicit first-turn outcomes", async () => {
		const store = new InMemoryEventStore<RuntimeEvent>();
		const sink = new DefaultEventSink<RuntimeEvent>(store);
		sink.registerRole(createChatTitleWorker<RuntimeEvent>());

		await sink.publish(runtimeEvent(1, "turn_outcome", { result: "finished" }));
		await sink.publish(runtimeEvent(2, "turn_outcome", { result: "finished", firstTurn: false }));
		await sink.publish(runtimeEvent(3, "turn_outcome", { result: "finished", firstTurn: true, title: "Hello" }));
		await sink.waitForIdle();

		expect(store.list().map((current) => current.type)).toEqual([
			"turn_outcome",
			"turn_outcome",
			"turn_outcome",
			"chat_title_generated",
		]);
		sink.dispose();
	});

	it("DisplayWorker emits ephemeral update signals without persisted per-chunk events", async () => {
		const store = new InMemoryEventStore<RuntimeEvent>();
		const sink = new DefaultEventSink<RuntimeEvent>(store);
		sink.registerRole(createDisplayWorker<RuntimeEvent>());

		await sink.publish(runtimeEvent(1, "message_chunk", { text: "hello" }));
		await sink.waitForIdle();

		expect(store.list().map((current) => current.type)).toEqual(["message_chunk"]);
		expect(sink.getSignalBus().read("Display/updated")?.payload).toMatchObject({
			sourceEventId: "runtime-1",
			chunkType: "message_chunk",
			text: "hello",
		});
		sink.dispose();
	});

	it("EventSink hydrates from event log via replay", async () => {
		type SinkEvent = EventEnvelope<"test.event", { value: number }>;
		const store = new InMemoryEventStore<SinkEvent>();
		const sink = new DefaultEventSink<SinkEvent>(store);
		sink.registerProjection({
			name: "count",
			initialState: 0,
			reduce: (state: number, event) => state + (event.type === "test.event" ? 1 : 0),
		});

		// Publish some events
		await sink.publish({
			id: "1",
			stream: "s",
			sequence: 1,
			type: "test.event",
			timestamp: "t",
			payload: { value: 1 },
		});
		await sink.publish({
			id: "2",
			stream: "s",
			sequence: 2,
			type: "test.event",
			timestamp: "t",
			payload: { value: 2 },
		});
		await sink.waitForIdle();

		// Simulate restart: create new sink and replay
		const store2 = new InMemoryEventStore<SinkEvent>();
		const existingEvents = store.list();
		const sink2 = new DefaultEventSink<SinkEvent>(store2);
		sink2.registerProjection({
			name: "count",
			initialState: 0,
			reduce: (state: number, event) => state + (event.type === "test.event" ? 1 : 0),
		});
		sink2.replay(existingEvents);

		expect(sink2.projections().get<number>("count")).toBe(2);
		expect(sink2.getSequence()).toBe(2);
		sink2.dispose();
		sink.dispose();
	});

	it("EventSink replay does not rerun roles", async () => {
		type SinkEvent = EventEnvelope<"test.event", { value: number }>;
		const store = new InMemoryEventStore<SinkEvent>();
		const sink = new DefaultEventSink<SinkEvent>(store);
		let roleRuns = 0;
		sink.registerProjection({
			name: "count",
			initialState: 0,
			reduce: (state: number, current) => state + (current.type === "test.event" ? 1 : 0),
		});
		sink.registerRole({
			name: "counter",
			match: (current) => current.type === "test.event",
			run: () => {
				roleRuns += 1;
			},
		});

		const events = [
			{ id: "1", stream: "s", sequence: 1, type: "test.event", timestamp: "t", payload: { value: 1 } },
			{ id: "2", stream: "s", sequence: 2, type: "test.event", timestamp: "t", payload: { value: 2 } },
		] satisfies SinkEvent[];
		sink.replay(events);
		await sink.waitForIdle();

		expect(sink.projections().get<number>("count")).toBe(2);
		expect(roleRuns).toBe(0);
		sink.dispose();
	});

	it("createSignal produces typed signal definitions", () => {
		const sig = createSignalDefinition("Test/mySignal", "A test signal");
		expect(sig.type).toBe("Test/mySignal");
		expect(sig.description).toBe("A test signal");
	});

	it("Checkpoint projection tracks turn-boundary checkpoints", () => {
		type CkEvent = EventEnvelope<"checkpoint.created" | "checkpoint.rolled_back", Record<string, unknown>>;
		const projections = new ProjectionStore<CkEvent>();
		projections.register(createCheckpointProjection<CkEvent>());

		projections.apply({
			id: "1",
			stream: "s",
			sequence: 1,
			type: "checkpoint.created",
			timestamp: "t",
			payload: { id: "ck1", treeOID: "abc", kind: "turn-start" },
		});
		projections.apply({
			id: "2",
			stream: "s",
			sequence: 2,
			type: "checkpoint.created",
			timestamp: "t",
			payload: { id: "ck2", treeOID: "def", kind: "turn-end" },
		});

		const state = projections.get<{ checkpoints: { id: string }[]; redoStack: string[] }>("Checkpoint")!;
		expect(state.checkpoints).toHaveLength(2);
		expect(state.redoStack).toHaveLength(0);

		// Roll back to ck1
		projections.apply({
			id: "3",
			stream: "s",
			sequence: 3,
			type: "checkpoint.rolled_back",
			timestamp: "t",
			payload: { checkpointId: "ck1" },
		});
		const state2 = projections.get<{ checkpoints: { id: string }[]; redoStack: string[] }>("Checkpoint")!;
		expect(state2.checkpoints).toHaveLength(1);
		expect(state2.redoStack).toEqual(["ck2"]);
	});
});
