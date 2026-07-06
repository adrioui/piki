import { describe, expect, it } from "vitest";
import { StateMachine } from "../src/fsm.ts";

describe("StateMachine G17 enrichment", () => {
	it("hold returns current state without mutating", () => {
		const m = new StateMachine<"idle" | "running" | "done", "start" | "finish", undefined>("idle", undefined, [
			{ from: "idle", event: "start", to: "running" },
			{ from: "running", event: "finish", to: "done" },
		]);
		expect(m.hold()).toBe("idle");
		expect(m.getState()).toBe(m.hold());
		m.hold();
		m.hold();
		expect(m.hold()).toBe("idle");
	});

	it("match projects when predicate matches, undefined otherwise", () => {
		const m = new StateMachine<"idle" | "running" | "done", "start" | "finish", undefined>("idle", undefined, [
			{ from: "idle", event: "start", to: "running" },
			{ from: "running", event: "finish", to: "done" },
		]);
		expect(
			m.match(
				(s) => s === "idle",
				() => 42,
			),
		).toBe(42);
		m.send("start");
		expect(
			m.match(
				(s) => s === "idle",
				() => 42,
			),
		).toBe(undefined);
		expect(
			m.match(
				(s) => s === "running",
				() => "ok",
			),
		).toBe("ok");
	});

	it("is returns correct state equality", () => {
		const m = new StateMachine<"idle" | "running" | "done", "start" | "finish", undefined>("idle", undefined, [
			{ from: "idle", event: "start", to: "running" },
			{ from: "running", event: "finish", to: "done" },
		]);
		expect(m.is("idle")).toBe(true);
		expect(m.is("running")).toBe(false);
		m.send("start");
		expect(m.is("idle")).toBe(false);
		expect(m.is("running")).toBe(true);
	});

	it("canTransition correctly reports transition availability", () => {
		const m = new StateMachine<"idle" | "running" | "done", "start" | "finish", undefined>("idle", undefined, [
			{ from: "idle", event: "start", to: "running" },
			{ from: "running", event: "finish", to: "done" },
		]);
		// From idle
		expect(m.canTransition("start")).toBe(true);
		expect(m.canTransition("finish")).toBe(false);
		m.send("start");
		// From running
		expect(m.canTransition("finish")).toBe(true);
		expect(m.canTransition("start")).toBe(false);
		m.send("finish");
		// From done
		expect(m.canTransition("start")).toBe(false);
		expect(m.canTransition("finish")).toBe(false);
	});

	it("isTerminal correctly identifies terminal states", () => {
		const m = new StateMachine<"idle" | "running" | "done", "start" | "finish", undefined>("idle", undefined, [
			{ from: "idle", event: "start", to: "running" },
			{ from: "running", event: "finish", to: "done" },
		]);
		expect(m.isTerminal("idle")).toBe(false);
		expect(m.isTerminal("running")).toBe(false);
		expect(m.isTerminal("done")).toBe(true);
		m.send("start");
		m.send("finish");
		expect(m.isTerminal()).toBe(true);
	});

	it("getTerminalStates returns all states with no outgoing transitions", () => {
		const m = new StateMachine<"idle" | "running" | "done", "start" | "finish", undefined>("idle", undefined, [
			{ from: "idle", event: "start", to: "running" },
			{ from: "running", event: "finish", to: "done" },
		]);
		expect(m.getTerminalStates()).toEqual(["done"]);

		const m2 = new StateMachine<"idle" | "running" | "done" | "aborted", "start" | "finish" | "abort", undefined>(
			"idle",
			undefined,
			[
				{ from: "idle", event: "start", to: "running" },
				{ from: "running", event: "finish", to: "done" },
				{ from: "idle", event: "abort", to: "aborted" },
			],
		);
		const terminals = m2.getTerminalStates();
		terminals.sort();
		expect(terminals).toEqual(["aborted", "done"]);
	});
});
