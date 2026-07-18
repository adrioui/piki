/**
 * Tests for detached-process SIGTERM-grace + SIGKILL-fallback behavior (FIX-RUNTIME-KILL).
 *
 * Mirrors mag's performKill: send SIGTERM first, then a 2000ms SIGKILL fallback.
 * Timers must be tracked per-PID and cleared so they cannot leak or keep the
 * event loop alive. All tests are mock-only (fake timers, spied process.kill).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetachedProcessRegistry } from "../src/core/detached-process-registry.ts";
import { clearKillTimer, killProcessTree } from "../src/utils/shell.ts";

const FAKE_PID = 4242;
const GROUP_PID = -FAKE_PID;

// Reset between tests so the module-level timer map never leaks.
beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	clearKillTimer(FAKE_PID);
});

function killSpy() {
	return vi.mocked(process.kill);
}

function assertSentSignal(signal: NodeJS.Signals, pid: number = GROUP_PID): void {
	const calls = killSpy().mock.calls.filter((c) => c[1] === signal);
	expect(
		calls.some((c) => c[0] === pid),
		`expected ${signal} to ${pid}`,
	).toBe(true);
}

function assertNotSentSignal(signal: NodeJS.Signals, pid: number = GROUP_PID): void {
	const calls = killSpy().mock.calls.filter((c) => c[1] === signal);
	expect(
		calls.some((c) => c[0] === pid),
		`expected NO ${signal} to ${pid}`,
	).toBe(false);
}

describe("killProcessTree (unix, SIGTERM grace before SIGKILL)", () => {
	it("sends SIGTERM to the group before any SIGKILL", () => {
		if (process.platform === "win32") return;
		killProcessTree(FAKE_PID);

		// SIGTERM must be sent immediately.
		assertSentSignal("SIGTERM", GROUP_PID);
		// No SIGKILL yet (only after the fallback timer fires).
		assertNotSentSignal("SIGKILL");
		assertNotSentSignal("SIGKILL", FAKE_PID);
	});

	it("sends SIGKILL via the armed 2000ms fallback timer", () => {
		if (process.platform === "win32") return;
		killProcessTree(FAKE_PID);
		assertNotSentSignal("SIGKILL");

		// Fire the fallback timer.
		vi.advanceTimersByTime(2000);

		assertSentSignal("SIGKILL", GROUP_PID);
	});

	it("does not re-signal after the fallback timer has fired (no timer leak)", () => {
		if (process.platform === "win32") return;
		killProcessTree(FAKE_PID);
		vi.advanceTimersByTime(2000);

		const sigkillCountAfterFirstFire = killSpy().mock.calls.filter((c) => c[1] === "SIGKILL").length;

		// Advancing further must not arm another SIGKILL.
		vi.advanceTimersByTime(5000);
		const sigkillCountAfterExtra = killSpy().mock.calls.filter((c) => c[1] === "SIGKILL").length;

		expect(sigkillCountAfterExtra).toBe(sigkillCountAfterFirstFire);
	});

	it("swallows errors when the process already exited at fallback time", () => {
		if (process.platform === "win32") return;
		// SIGKILL throws (process already gone) — must be swallowed.
		killSpy().mockImplementation((_pid: number, signal: string | number | undefined) => {
			if (signal === "SIGKILL") throw new Error("ESRCH");
			return true;
		});

		expect(() => {
			killProcessTree(FAKE_PID);
			vi.advanceTimersByTime(2000);
		}).not.toThrow();

		// SIGKILL was still attempted (mag checks at fire time, then kill).
		assertSentSignal("SIGKILL", GROUP_PID);
	});

	it("clears a pending timer via clearKillTimer (no leak)", () => {
		if (process.platform === "win32") return;
		killProcessTree(FAKE_PID);
		clearKillTimer(FAKE_PID);

		// Timer cleared: advancing must NOT deliver SIGKILL.
		vi.advanceTimersByTime(2000);
		assertNotSentSignal("SIGKILL");
	});
});

describe("DetachedProcessRegistry.killAll (SIGTERM grace before SIGKILL)", () => {
	const FORK = "fork-1";

	function makeRegistry(pids: number[]): DetachedProcessRegistry {
		const reg = new DetachedProcessRegistry();
		for (const pid of pids) reg.register(pid, FORK);
		return reg;
	}

	it("sends SIGTERM to each pid before SIGKILL", () => {
		const reg = makeRegistry([FAKE_PID]);
		reg.killAll(FORK);

		assertSentSignal("SIGTERM", FAKE_PID);
		assertNotSentSignal("SIGKILL", FAKE_PID);
	});

	it("sends SIGKILL via the 2000ms fallback timer", () => {
		const reg = makeRegistry([FAKE_PID]);
		reg.killAll(FORK);
		vi.advanceTimersByTime(2000);

		assertSentSignal("SIGKILL", FAKE_PID);
	});

	it("swallows errors when a pid already exited at fallback time", () => {
		killSpy().mockImplementation((_pid: number, signal: string | number | undefined) => {
			if (signal === "SIGKILL") throw new Error("ESRCH");
			return true;
		});
		const reg = makeRegistry([FAKE_PID]);

		expect(() => {
			reg.killAll(FORK);
			vi.advanceTimersByTime(2000);
		}).not.toThrow();

		assertSentSignal("SIGKILL", FAKE_PID);
	});

	it("clears pending timers on unregister", () => {
		const reg = makeRegistry([FAKE_PID]);
		reg.killAll(FORK);
		reg.unregister(FAKE_PID);

		// unregister must clear the fallback timer so it never fires.
		vi.advanceTimersByTime(2000);
		assertNotSentSignal("SIGKILL", FAKE_PID);
	});

	it("clears pending timers on dispose", () => {
		const reg = makeRegistry([FAKE_PID]);
		reg.killAll(FORK);
		reg.dispose();

		vi.advanceTimersByTime(2000);
		assertNotSentSignal("SIGKILL", FAKE_PID);
	});
});
