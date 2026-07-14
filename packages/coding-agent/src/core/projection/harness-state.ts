import { defineForked } from "./projection.ts";

export interface HarnessStateFork {
	engine: { stopped: boolean; [key: string]: unknown };
	[key: string]: unknown;
}

export const HarnessStateProjection = defineForked<HarnessStateFork>()({
	name: "HarnessState",
	initialFork: { engine: { stopped: false } },
	eventHandlers: {},
	forkLifecycle: { activateOn: "turn_started" },
});
