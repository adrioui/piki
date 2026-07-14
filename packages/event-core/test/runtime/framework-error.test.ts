import { Effect, Layer, PubSub, Queue } from "effect";
import { describe, expect, it } from "vitest";
import {
	FrameworkErrorPubSub,
	FrameworkErrorPubSubLive,
	FrameworkErrorReporter,
	FrameworkErrorReporterLive,
	RoleError,
	StorageError,
} from "../../src/runtime/framework-error.ts";

const TestLayer = FrameworkErrorReporterLive.pipe(Layer.provideMerge(FrameworkErrorPubSubLive));

describe("FrameworkError", () => {
	it("new RoleError has _tag === 'RoleError' and carries fields", () => {
		const err = new RoleError({ roleId: "scout", message: "boom", cause: new Error("x") });
		expect(err._tag).toBe("RoleError");
		expect(err.roleId).toBe("scout");
		expect(err.message).toBe("boom");
	});

	it("report() publishes to the pubsub; a subscriber takes the error in order", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const bus = yield* FrameworkErrorPubSub;
					const sub = yield* PubSub.subscribe(bus.pubsub);
					const reporter = yield* FrameworkErrorReporter;
					yield* reporter.report(new RoleError({ roleId: "r1", message: "first" }));
					const taken = yield* Queue.take(sub);
					expect(taken._tag).toBe("RoleError");
					expect((taken as RoleError).roleId).toBe("r1");
				}),
			).pipe(Effect.provide(TestLayer)),
		);
	});

	it("report() never throws even if the pubsub is shut down (error isolation)", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const bus = yield* FrameworkErrorPubSub;
				yield* PubSub.shutdown(bus.pubsub);
				const reporter = yield* FrameworkErrorReporter;
				yield* reporter.report(new StorageError({ operation: "read", path: "/x", message: "dead bus" }));
			}).pipe(Effect.provide(TestLayer)),
		);
		expect(true).toBe(true);
	});

	it("Effect.catchTags routes a thrown RoleError to its handler", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* Effect.fail(new RoleError({ roleId: "r2", message: "tagged" }));
			}).pipe(
				Effect.catchTags({
					RoleError: (e) => Effect.succeed(`caught:${e.roleId}`),
				}),
			),
		);
		expect(result).toBe("caught:r2");
	});
});
