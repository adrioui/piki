import { defineForked } from "./projection.ts";

export interface ProcessInfo {
	pid: number;
	command: string;
	forkId: string;
	ownerAgentId: string;
	startedAt: string;
	stdoutPath: string | null;
	stderrPath: string | null;
	status: "running" | "killed" | "completed";
	exitCode: number | null;
	cpuPercent: number | null;
	rssBytes: number | null;
	lastMetricsAt: string | null;
	peakCpuPercent: number | null;
	peakRssBytes: number | null;
}

export interface DetachedProcessState {
	processes: Map<number, ProcessInfo>;
}

export const DetachedProcessProjection = defineForked<DetachedProcessState>()({
	name: "DetachedProcess",
	initialFork: { processes: new Map() },
	eventHandlers: {},
	forkLifecycle: { activateOn: "turn_started" },
});
