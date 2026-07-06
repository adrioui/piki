// packages/coding-agent/test/runtime/logger.test.ts
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Logger, LoggerNoop } from "../../src/runtime/logger.ts";
import { makeConsoleLoggerLayer } from "../../src/runtime/logger-layer.ts";

describe("Logger", () => {
	it.effect("LoggerNoop.log resolves void and writes nothing", () =>
		Effect.gen(function* () {
			const logger = yield* Logger;
			const result = yield* logger.log("error", { msg: "test" });
			expect(result).toBeUndefined();
		}).pipe(Effect.provide(LoggerNoop)),
	);

	it.effect("ConsoleLoggerLayer respects minLevel filter", () =>
		Effect.gen(function* () {
			const lines: Array<string> = [];
			const layer = makeConsoleLoggerLayer({
				minLevel: "warn",
				writer: (line: string) => {
					lines.push(line);
				},
			});

			const logger = yield* Effect.provide(Logger, layer);

			// Debug should be filtered out
			yield* logger.log("debug", { msg: "should not appear" });
			expect(lines.length).toBe(0);

			// Warn should appear
			yield* logger.log("warn", { msg: "this appears" });
			expect(lines.length).toBe(1);
		}),
	);

	it.effect("written line parses as JSON with level, timestamp, and merged fields", () =>
		Effect.gen(function* () {
			const lines: Array<string> = [];
			const layer = makeConsoleLoggerLayer({
				writer: (line: string) => {
					lines.push(line);
				},
			});

			const logger = yield* Effect.provide(Logger, layer);
			yield* logger.log("info", { component: "test", code: 42 });

			expect(lines.length).toBe(1);
			const parsed = JSON.parse(lines[0]);
			expect(parsed).toHaveProperty("level", "info");
			expect(parsed).toHaveProperty("timestamp");
			expect(typeof parsed.timestamp).toBe("string");
			expect(parsed).toHaveProperty("component", "test");
			expect(parsed).toHaveProperty("code", 42);
		}),
	);

	it.effect("namespace scoping produces ns field", () =>
		Effect.gen(function* () {
			const lines: Array<string> = [];
			const layer = makeConsoleLoggerLayer({
				writer: (line: string) => {
					lines.push(line);
				},
			});

			const rootLogger = yield* Effect.provide(Logger, layer);
			const fooLogger = yield* rootLogger.namespace("foo");
			const barLogger = yield* fooLogger.namespace("bar");

			yield* barLogger.log("info", { event: "test" });

			expect(lines.length).toBe(1);
			const parsed = JSON.parse(lines[0]);
			expect(parsed).toHaveProperty("ns", "foo:bar");
			expect(parsed).toHaveProperty("event", "test");
		}),
	);

	it.effect("log does not throw on circular reference in fields", () =>
		Effect.gen(function* () {
			const lines: Array<string> = [];
			const layer = makeConsoleLoggerLayer({
				writer: (line: string) => {
					lines.push(line);
				},
			});

			const logger = yield* Effect.provide(Logger, layer);

			const circular: Record<string, unknown> = { label: "circular-test" };
			circular.self = circular;

			// This should not throw — Effect.try catches the JSON.stringify error
			const result = yield* logger.log("warn", {
				msg: "circular test",
				data: circular,
			});
			expect(result).toBeUndefined();
			// The log failed to stringify, so no line was written
			expect(lines.length).toBe(0);
		}),
	);
});
