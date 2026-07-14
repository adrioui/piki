import { Effect, ExecutionStrategy, Exit, Scope } from "effect";

export type SessionOperation = "compaction" | "branchSummary" | "retry" | "bash";

export class SessionCancellationScope {
	private scope = Effect.runSync(Scope.make(ExecutionStrategy.sequential));
	private readonly controllers = new Map<SessionOperation, AbortController>();

	create(operation: SessionOperation): AbortController {
		this.abort(operation);
		const controller = new AbortController();
		this.controllers.set(operation, controller);
		Effect.runSync(
			Scope.addFinalizer(
				this.scope,
				Effect.sync(() => {
					if (!controller.signal.aborted) {
						controller.abort();
					}
				}),
			),
		);
		return controller;
	}

	clear(operation: SessionOperation, controller: AbortController | undefined): void {
		if (controller && this.controllers.get(operation) === controller) {
			this.controllers.delete(operation);
		}
	}

	abort(operation: SessionOperation): void {
		const controller = this.controllers.get(operation);
		if (controller && !controller.signal.aborted) {
			controller.abort();
		}
		this.controllers.delete(operation);
	}

	close(): void {
		Effect.runSync(Scope.close(this.scope, Exit.void));
		this.controllers.clear();
		this.scope = Effect.runSync(Scope.make(ExecutionStrategy.sequential));
	}
}
