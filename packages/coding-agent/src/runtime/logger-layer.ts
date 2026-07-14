// packages/coding-agent/src/runtime/logger-layer.ts
import { Effect, Layer } from "effect";
import { type LogFields, Logger, type LoggerShape, type LogLevel } from "./logger.ts";

export interface ConsoleLoggerOptions {
	/** Minimum level to emit. Default: "info". */
	readonly minLevel?: LogLevel;
	/** Write to stderr (default) or stdout (mutually exclusive with writer). */
	readonly sink?: "stderr" | "stdout";
	/** If true, pretty-print JSON (indented). Default: false (compact). */
	readonly pretty?: boolean;
	/**
	 * Optional writer function for testability.
	 * When provided, `sink` is ignored and lines are passed to this function.
	 * Default behavior writes to process.stderr / process.stdout.
	 */
	readonly writer?: (line: string) => void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

function resolveWriter(options: ConsoleLoggerOptions): (line: string) => void {
	if (options.writer) return options.writer;
	if (options.sink === "stdout") {
		return (line: string) => process.stdout.write(`${line}\n`);
	}
	return (line: string) => process.stderr.write(`${line}\n`);
}

/**
 * Live logger layer: writes structured JSON lines to stderr.
 * Each entry: { level, timestamp, ...fields }.
 *
 * The log effect never throws — circular references in fields are caught
 * and replaced with a placeholder string.
 */
export function makeConsoleLoggerLayer(options: ConsoleLoggerOptions = {}) {
	const minLevel = options.minLevel ?? "info";
	const minPriority = LEVEL_PRIORITY[minLevel];
	const write = resolveWriter(options);

	return Layer.effect(
		Logger,
		Effect.gen(function* () {
			const makeShape = (nsStack: string[]): LoggerShape => ({
				log: (level: LogLevel, fields: LogFields) =>
					Effect.sync(() => {
						// log must never throw — wrap in try/catch
						try {
							if (LEVEL_PRIORITY[level] < minPriority) return;
							const entry: Record<string, unknown> = {
								level,
								timestamp: new Date().toISOString(),
								...fields,
							};
							if (nsStack.length > 0) {
								entry.ns = nsStack.join(":");
							}
							const line = options.pretty ? JSON.stringify(entry, null, 2) : JSON.stringify(entry);
							write(line);
						} catch {
							// silently ignore — log should never fail
						}
					}),
				namespace: (ns: string) => Effect.succeed(makeShape([...nsStack, ns])),
			});
			return makeShape([]);
		}),
	);
}
