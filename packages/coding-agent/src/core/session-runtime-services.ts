import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { DetachedProcessRegistry } from "./detached-process-registry.ts";
import { ScratchpadManager } from "./scratchpad-manager.ts";
import { SessionCancellationScope, type SessionOperation } from "./session-cancellation-scope.ts";

export type RuntimeEventPublisher = (type: string, payload: Record<string, unknown>) => Promise<void> | void;

export interface ToolResultSidecarInput {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result: unknown;
	isError: boolean;
}

export interface SessionRuntimeServicesShape {
	readonly cwd: string;
	readonly scratchpad: ScratchpadManager;
	readonly cancellationScope: SessionCancellationScope;
	readonly processRegistry: DetachedProcessRegistry;
	readonly publishRuntimeEvent: (type: string, payload: Record<string, unknown>) => Effect.Effect<void, unknown>;
	readonly saveToolResultSidecar: (input: ToolResultSidecarInput) => Effect.Effect<string, unknown>;
	readonly createAbortController: (operation: SessionOperation) => Effect.Effect<AbortController>;
	readonly close: () => Effect.Effect<void>;
}

export interface CreateSessionRuntimeServicesOptions {
	cwd: string;
	sessionId: string;
	publishRuntimeEvent?: RuntimeEventPublisher;
}

export const SessionRuntimeServices = Context.GenericTag<SessionRuntimeServicesShape>("SessionRuntimeServices");

export function createSessionRuntimeServices(
	options: CreateSessionRuntimeServicesOptions,
): SessionRuntimeServicesShape {
	const scratchpad = new ScratchpadManager({
		rootDir: join(options.cwd, ".piki", "scratchpad"),
		autoCreate: true,
	});
	scratchpad.setSessionId(options.sessionId);
	const cancellationScope = new SessionCancellationScope();
	const processRegistry = new DetachedProcessRegistry();

	return {
		cwd: options.cwd,
		scratchpad,
		cancellationScope,
		processRegistry,
		publishRuntimeEvent: Effect.fn("SessionRuntimeServices.publishRuntimeEvent")(function* (
			type: string,
			payload: Record<string, unknown>,
		) {
			if (!options.publishRuntimeEvent) return;
			yield* Effect.tryPromise(() => Promise.resolve(options.publishRuntimeEvent?.(type, payload)));
		}),
		saveToolResultSidecar: Effect.fn("SessionRuntimeServices.saveToolResultSidecar")(function* (
			input: ToolResultSidecarInput,
		) {
			return yield* Effect.try(() =>
				scratchpad.saveJsonResult(
					`${input.toolName}-${input.toolCallId}`,
					{
						toolCallId: input.toolCallId,
						toolName: input.toolName,
						args: input.args,
						result: input.result,
						isError: input.isError,
					},
					{
						toolCallId: input.toolCallId,
						toolName: input.toolName,
						isError: input.isError,
					},
				),
			);
		}),
		createAbortController: Effect.fn("SessionRuntimeServices.createAbortController")(function* (
			operation: SessionOperation,
		) {
			return yield* Effect.sync(() => cancellationScope.create(operation));
		}),
		close: Effect.fn("SessionRuntimeServices.close")(function* () {
			yield* Effect.sync(() => cancellationScope.close());
		}),
	};
}

export function createSessionRuntimeServicesLayer(options: CreateSessionRuntimeServicesOptions) {
	return Layer.succeed(SessionRuntimeServices, createSessionRuntimeServices(options));
}
