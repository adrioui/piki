import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";

/**
 * Regression for A5: `runRpcMode` must register an `unhandledRejection`
 * handler that routes a stray rejection to graceful `shutdown` instead of
 * crashing the persistent RPC host. It also registers a `beforeExit` handler
 * (mag parity, G1) to run tracked-child cleanup on idle event-loop drain.
 */

type Unsub = () => void;

function makeFakeSession(bindCount: { value: number }): Record<string, unknown> {
	return {
		bindExtensions: vi.fn((_options: unknown): void => {
			bindCount.value++;
		}),
		subscribe: vi.fn((): Unsub => () => {}),
		waitForIdle: vi.fn(async (): Promise<void> => {}),
		agent: { subscribe: vi.fn((): Unsub => () => {}) },
	};
}

function makeFakeHost(session: Record<string, unknown>, disposeCount: { value: number }): AgentSessionRuntime {
	return {
		session,
		setRebindSession: vi.fn((_fn: unknown): void => {}),
		newSession: vi.fn(async () => ({})),
		fork: vi.fn(async () => ({ cancelled: false })),
		switchSession: vi.fn(async () => ({})),
		dispose: vi.fn((): void => {
			disposeCount.value++;
		}),
	} as unknown as AgentSessionRuntime;
}

const tick = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("A5: RPC mode routes unhandledRejection to graceful shutdown", () => {
	afterEach(() => {
		// shutdown() removes its own listener via signalCleanupHandlers; clear any
		// residual to keep the event isolated between tests.
		process.removeAllListeners("unhandledRejection");
		process.removeAllListeners("beforeExit");
	});

	it("shuts the RPC host down (not raw crash) when an unhandled rejection occurs", async () => {
		const bindCount = { value: 0 };
		const disposeCount = { value: 0 };
		const session = makeFakeSession(bindCount);
		const host = makeFakeHost(session, disposeCount);

		let lastExit: number | undefined;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			lastExit = code ?? 0;
			return undefined as never;
		}) as typeof process.exit);

		// Start the (never-resolving) RPC event loop without awaiting it.
		const rpcPromise = runRpcMode(host);
		expect(rpcPromise).toBeInstanceOf(Promise);
		await tick();

		// Setup completed: the session was bound and the handlers are registered.
		expect(bindCount.value).toBeGreaterThan(0);

		// Simulate a stray rejection. `process.emit("unhandledRejection", ...)`
		// is a no-op in the vitest worker (its own rejection monitor swallows it),
		// so invoke the handler piki actually registered on the process directly.
		const rejectionListeners = process.listeners("unhandledRejection");
		const handler = rejectionListeners[rejectionListeners.length - 1] as (reason: unknown) => void;
		handler(new Error("boom"));
		await tick();

		expect(disposeCount.value).toBeGreaterThan(0);
		expect(lastExit).toBe(1);

		exitSpy.mockRestore();
	});

	it("registers a beforeExit handler that tears down tracked children on idle drain (mag parity)", async () => {
		const session = makeFakeSession({ value: 0 });
		const host = makeFakeHost(session, { value: 0 });

		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);

		const rpcPromise = runRpcMode(host);
		expect(rpcPromise).toBeInstanceOf(Promise);
		await tick();

		// mag registers a `beforeExit` handler to run tracked-child cleanup on
		// idle event-loop drain; piki mirrors this for parity (G1).
		expect(process.listeners("beforeExit")).toHaveLength(1);

		exitSpy.mockRestore();
	});
});
