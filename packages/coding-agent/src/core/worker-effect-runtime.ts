import { Effect, Fiber, Queue, STM, TSemaphore } from "effect";
import type { WorkerSession } from "./worker-session.ts";

export class WorkerEffectRuntime {
	private readonly registrySemaphore = Effect.runSync(STM.commit(TSemaphore.make(1)));
	private readonly messageQueues = new Map<string, Queue.Queue<string>>();
	private readonly fibers = new Map<string, Fiber.Fiber<void, unknown>>();

	async createMessageQueue(agentId: string): Promise<Queue.Queue<string>> {
		return Effect.runPromise(
			TSemaphore.withPermit(this.registrySemaphore)(
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
		// Queue.take blocks until a value; queue shutdown causes Effect.fail
		for (;;) {
			const exit = await Effect.runPromiseExit(Queue.take(queue));
			if (exit._tag === "Success") {
				deliver(exit.value);
			} else {
				break; // queue shut down
			}
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
		let queue: Queue.Queue<string> | undefined;
		await Effect.runPromise(
			TSemaphore.withPermit(this.registrySemaphore)(
				Effect.sync(() => {
					queue = this.messageQueues.get(agentId);
					this.messageQueues.delete(agentId);
					this.fibers.delete(agentId);
				}),
			),
		);
		// Shut down the queue so any blocked `Queue.take` in drainMessages
		// unblocks (runPromiseExit turns the shutdown into a Failure exit that
		// breaks the drain loop). Without this, spawned workers hang forever.
		if (queue) {
			await Effect.runPromise(Queue.shutdown(queue));
		}
	}

	async dispose(sessions: Iterable<WorkerSession>): Promise<void> {
		for (const session of sessions) {
			session.kill();
		}
		for (const fiber of this.fibers.values()) {
			await Effect.runPromise(Fiber.interrupt(fiber));
		}
		this.fibers.clear();
		// Shut down all message queues so any blocked drainMessages loops unblock
		// before we drop the references.
		for (const queue of this.messageQueues.values()) {
			await Effect.runPromise(Queue.shutdown(queue));
		}
		this.messageQueues.clear();
	}
}
