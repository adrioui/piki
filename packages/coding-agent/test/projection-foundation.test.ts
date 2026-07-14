import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	ambientDefine,
	applyProjectionEvent,
	createProjectionState,
	define,
	defineForked,
	resolveAmbient,
} from "../src/core/projection/projection.ts";

describe("projection foundation", () => {
	it("reduces global projection events and emits signals", () => {
		const counter = define<{ count: number }>()({
			name: "Counter",
			initial: { count: 0 },
			signals: { changed: { name: "Counter/changed" } },
			eventHandlers: {
				increment: ({ state, emit }) => {
					const next = { count: state.count + 1 };
					emit.changed(next.count);
					return next;
				},
			},
		});
		const emitted: Array<{ signal: string; value: unknown }> = [];
		const state = applyProjectionEvent(
			counter,
			createProjectionState(counter),
			"increment",
			{},
			{
				emit: (signal, value) => emitted.push({ signal: signal.name, value }),
			},
		);

		expect(state).toEqual({ count: 1 });
		expect(emitted).toEqual([{ signal: "Counter/changed", value: 1 }]);
	});

	it("reduces forked projection events", () => {
		const forked = defineForked<{ status: string }>()({
			name: "Forked",
			initialFork: { status: "working" },
			eventHandlers: {
				done: ({ fork }) => ({ ...fork, status: "done" }),
			},
			forkLifecycle: { activateOn: "started", completeOn: "done" },
		});

		expect(applyProjectionEvent(forked, createProjectionState(forked), "done", {})).toEqual({ status: "done" });
	});

	it("deep-clones nested mutable initial state", () => {
		const projection = define<{ agents: Map<string, { status: string }> }>()({
			name: "Nested",
			initial: { agents: new Map([["a", { status: "working" }]]) },
			eventHandlers: {},
		});

		const first = createProjectionState(projection);
		const second = createProjectionState(projection);
		const firstAgent = first.agents.get("a");
		if (!firstAgent) throw new Error("expected first agent");
		firstAgent.status = "mutated";

		expect(second.agents.get("a")?.status).toBe("working");
	});

	it("resolves sync and Effect ambients", async () => {
		const syncAmbient = ambientDefine({ name: "sync", initial: "value" });
		const effectAmbient = ambientDefine({ name: "effect", initial: Effect.succeed("effect-value") });

		await expect(Effect.runPromise(resolveAmbient(syncAmbient))).resolves.toBe("value");
		await expect(Effect.runPromise(resolveAmbient(effectAmbient))).resolves.toBe("effect-value");
	});
});
