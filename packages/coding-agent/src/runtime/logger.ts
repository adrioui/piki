// packages/coding-agent/src/runtime/logger.ts
import { Context, Effect, Layer } from "effect";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured log fields. Always an object — no positional args. */
export type LogFields = Record<string, unknown>;

export interface LoggerShape {
	/** Emit a structured log entry. The effect never fails. */
	readonly log: (level: LogLevel, fields: LogFields) => Effect.Effect<void>;
	/** Convenience: scoped child logger that merges a base namespace. */
	readonly namespace: (ns: string) => Effect.Effect<LoggerShape>;
}

export const Logger = Context.GenericTag<LoggerShape>("Logger");

const noopShape = (nsStack: string[]): LoggerShape => ({
	log: (_level: LogLevel, _fields: LogFields) => Effect.void,
	namespace: (ns: string) => Effect.succeed(noopShape([...nsStack, ns])),
});

/** No-op layer — default when no sink is configured. Never fails, does nothing. */
export const LoggerNoop = Layer.succeed(Logger, noopShape([]));
