/**
 * Detached process registry — per-fork process tracking with output streaming.
 * On worker kill, killAll(forkId) terminates all processes for that fork.
 */

export interface DetachedProcessEntry {
	pid: number;
	forkId: string;
	startedAt: number;
	outputPath?: string;
}

/**
 * Tracks the SIGKILL fallback timers armed by killAll, keyed by PID. Prevents
 * the 2000ms setTimeout from leaking or keeping the event loop alive after a
 * process is gone. Mirrors mag's per-PID kill-timer tracking.
 */
const killTimersByPid = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Clear the SIGKILL fallback timer for a PID (if any). Safe to call when no
 * timer is registered for the PID.
 */
export function clearKillTimer(pid: number): void {
	const timer = killTimersByPid.get(pid);
	if (timer === undefined) return;
	clearTimeout(timer);
	killTimersByPid.delete(pid);
}

export class DetachedProcessRegistry {
	private readonly processes = new Map<number, DetachedProcessEntry>();
	private readonly byFork = new Map<string, Set<number>>();

	register(pid: number, forkId: string, options?: { outputPath?: string }): void {
		const entry: DetachedProcessEntry = {
			pid,
			forkId,
			startedAt: Date.now(),
			outputPath: options?.outputPath,
		};
		this.processes.set(pid, entry);
		let forkSet = this.byFork.get(forkId);
		if (!forkSet) {
			forkSet = new Set();
			this.byFork.set(forkId, forkSet);
		}
		forkSet.add(pid);
	}

	unregister(pid: number): void {
		clearKillTimer(pid);
		const entry = this.processes.get(pid);
		if (!entry) return;
		this.processes.delete(pid);
		this.byFork.get(entry.forkId)?.delete(pid);
	}

	killAll(forkId: string): void {
		const pids = this.byFork.get(forkId);
		if (!pids) return;
		for (const pid of pids) {
			// Send SIGTERM first to allow graceful shutdown/flush, then arm a
			// SIGKILL fallback after a 2000ms grace period (matching mag).
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Already dead; nothing to signal
			}
			clearKillTimer(pid);
			const timer = setTimeout(() => {
				killTimersByPid.delete(pid);
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Process already gone
				}
			}, 2000);
			killTimersByPid.set(pid, timer);
			this.processes.delete(pid);
		}
		this.byFork.delete(forkId);
	}

	getProcessesForFork(forkId: string): DetachedProcessEntry[] {
		const pids = this.byFork.get(forkId);
		if (!pids) return [];
		return [...pids].map((pid) => this.processes.get(pid)).filter((e): e is DetachedProcessEntry => e !== undefined);
	}

	dispose(): void {
		for (const [forkId] of this.byFork) {
			this.killAll(forkId);
		}
		for (const pid of killTimersByPid.keys()) {
			clearKillTimer(pid);
		}
	}
}
