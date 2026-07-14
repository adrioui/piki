// Detached process tracking projection (event-core defineForked).
//
// Tracks detached subprocesses per fork and records their metric samples so the
// ProcessMetrics worker can read running pids and accumulate cpu/rss peaks.
//
// This projection lives in `@piki/agent-core`.

import { defineForkedProjection } from "@piki/event-core";

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

function isKillExitCode(exitCode: number | null): boolean {
	return exitCode !== null && exitCode !== 0 ? exitCode === 130 || exitCode === 143 || exitCode === 137 : false;
}

function markForkProcessesKilled(state: { forks: Map<string | null, DetachedProcessState> }, forkId: string | null) {
	const fork = state.forks.get(forkId);
	if (!fork) return state;
	const processes = new Map(fork.processes);
	let mutated = false;
	for (const [pid, proc] of processes) {
		if (proc.status === "running") {
			processes.set(pid, { ...proc, status: "killed" });
			mutated = true;
		}
	}
	if (!mutated) return state;
	const forks = new Map(state.forks);
	forks.set(forkId, { processes });
	return { forks };
}

export const DetachedProcessProjection = defineForkedProjection()({
	name: "DetachedProcess",
	initialFork: { processes: new Map() },
	eventHandlers: {
		turn_outcome: ({ fork }: { fork: DetachedProcessState }) => {
			const processes = new Map(fork.processes);
			let mutated = false;
			for (const [pid, proc] of processes) {
				if (proc.status !== "running") {
					processes.delete(pid);
					mutated = true;
				}
			}
			if (!mutated) return fork;
			return { processes };
		},
		shell_process_registered: ({ event, fork }: { event: any; fork: DetachedProcessState }) => {
			const processes = new Map(fork.processes);
			processes.set(event.pid, {
				pid: event.pid,
				command: event.command,
				forkId: event.forkId,
				ownerAgentId: event.ownerAgentId,
				startedAt: event.startedAt,
				stdoutPath: event.stdoutPath,
				stderrPath: event.stderrPath,
				status: "running",
				exitCode: null,
				cpuPercent: null,
				rssBytes: null,
				lastMetricsAt: null,
				peakCpuPercent: null,
				peakRssBytes: null,
			});
			return { processes };
		},
		shell_process_exited: ({ event, fork }: { event: any; fork: DetachedProcessState }) => {
			const proc = fork.processes.get(event.pid);
			if (!proc) return fork;
			const processes = new Map(fork.processes);
			processes.set(event.pid, {
				...proc,
				status: isKillExitCode(event.exitCode) ? "killed" : "completed",
				exitCode: event.exitCode,
			});
			return { processes };
		},
		shell_process_metrics: ({ event, fork }: { event: any; fork: DetachedProcessState }) => {
			if (event.samples.length === 0) return fork;
			const processes = new Map(fork.processes);
			let mutated = false;
			for (const sample of event.samples) {
				const proc = processes.get(sample.pid);
				if (!proc || proc.status !== "running") continue;
				const peakCpu =
					proc.peakCpuPercent != null ? Math.max(proc.peakCpuPercent, sample.cpuPercent) : sample.cpuPercent;
				const peakRss = proc.peakRssBytes != null ? Math.max(proc.peakRssBytes, sample.rssBytes) : sample.rssBytes;
				processes.set(sample.pid, {
					...proc,
					cpuPercent: sample.cpuPercent,
					rssBytes: sample.rssBytes,
					lastMetricsAt: sample.timestamp,
					peakCpuPercent: peakCpu,
					peakRssBytes: peakRss,
				});
				mutated = true;
			}
			if (!mutated) return fork;
			return { processes };
		},
	},
	globalEventHandlers: {
		agent_killed: ({ event, state }: { event: any; state: { forks: Map<string | null, DetachedProcessState> } }) =>
			markForkProcessesKilled(state, event.forkId),
		subagent_user_killed: ({
			event,
			state,
		}: {
			event: any;
			state: { forks: Map<string | null, DetachedProcessState> };
		}) => markForkProcessesKilled(state, event.forkId),
	},
});
