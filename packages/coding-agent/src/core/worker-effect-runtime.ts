import { Effect, Fiber, Queue, Semaphore } from "effect";
import type { WorkerSession } from "./worker-session.ts";

export class WorkerEffectRuntime {
	private readonly registrySemaphore = Semaphore.makeUnsafe(1);
	private readonly messageQueues = new Map<string, Queue.Queue<string>>();
	private readonly fibers = new Map<string, Fiber.Fiber<void, unknown>>();

	async createMessageQueue(agentId: string): Promise<Queue.Queue<string>> {
		return Effect.runPromise(
			this.registrySemaphore.withPermit(
				Effect.sync(() => {
					let queue = this.messageQueues.get(agentId);
					if (!queue) {
						queue = Effect.runSync(Queue.bounded<string>(100));
						this.messageQueues.set(agentId, queue);
					}
					return queue;
				}),
			),
		);
	}

	async offerMessage(agentId: string, message: string): Promise<void> {
		const queue = await this.createMessageQueue(agentId);
		await Effect.runPromise(Queue.offer(queue, message));
	}

	async drainMessages(agentId: string, deliver: (message: string) => void): Promise<void> {
		const queue = await this.createMessageQueue(agentId);
		let next = Queue.takeUnsafe(queue);
		while (next) {
			if (next._tag === "Success") {
				deliver(next.value);
			}
			next = Queue.takeUnsafe(queue);
		}
	}

	startSession(agentId: string, session: WorkerSession, onCrash: (error: unknown) => void): void {
		const fiber = Effect.runFork(Effect.tryPromise(() => session.start()));
		this.fibers.set(agentId, fiber);
		fiber.addObserver((exit) => {
			this.fibers.delete(agentId);
			if (exit._tag === "Failure") {
				onCrash(exit.cause);
			}
		});
	}

	async killSession(agentId: string, session: WorkerSession): Promise<void> {
		session.kill();
		const fiber = this.fibers.get(agentId);
		if (fiber) {
			await Effect.runPromise(Fiber.interrupt(fiber));
			this.fibers.delete(agentId);
		}
	}

	async removeWorker(agentId: string): Promise<void> {
		await Effect.runPromise(
			this.registrySemaphore.withPermit(
				Effect.sync(() => {
					this.messageQueues.delete(agentId);
					this.fibers.delete(agentId);
				}),
			),
		);
	}

	dispose(sessions: Iterable<WorkerSession>): void {
		for (const session of sessions) {
			session.kill();
		}
		for (const fiber of this.fibers.values()) {
			fiber.interruptUnsafe();
		}
		this.fibers.clear();
		this.messageQueues.clear();
	}
}
