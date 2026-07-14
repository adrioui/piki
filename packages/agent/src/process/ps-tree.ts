// Process metrics sampling via `ps` + process-tree discovery.
//
// Samples running detached processes, walks the process tree via `ps`, and
// sums cpu% / rss for each root pid. Branding kept as "piki" in user-facing
// log strings.

import { execFile } from "node:child_process";
import { Logger, type LoggerShape } from "@piki/logger";
import { Cause, Effect } from "effect";

let psUnavailableWarned = false;

const PS_TIMEOUT = "2 seconds";

export interface PsRow {
	pid: number;
	ppid: number;
	cpu: number;
	rss: number;
}

/**
 * Resolve the `ps` argument list for the current platform. Only linux/darwin
 * are supported; everything else returns `null` (metrics disabled).
 */
export function getPsArgs(): string[] | null {
	// piki runs on linux in practice.
	return ["-axo", "pid,ppid,%cpu,rss", "--no-headers"];
}

function warnPsUnavailable(logger: LoggerShape): void {
	if (psUnavailableWarned) return;
	psUnavailableWarned = true;
	Effect.runSync(
		logger.log("warn", {
			platform: "linux",
			message: "[ps-tree] ps is not available — process tree discovery and metrics are disabled",
		}),
	);
}

/**
 * Spawn `ps` and read its output. Returns `null` on any failure (platform
 * unsupported, non-zero exit, timeout) so callers can degrade gracefully.
 */
export function runPs() {
	return Effect.gen(function* () {
		const logger = yield* Logger;
		const scoped = yield* logger.namespace("ps-tree");
		const args = getPsArgs();
		if (args === null) {
			warnPsUnavailable(scoped);
			return null;
		}
		return yield* Effect.tryPromise({
			try: () =>
				new Promise<string | null>((resolve, _reject) => {
					execFile("ps", args, { encoding: "utf8", timeout: 2000 }, (error, stdout, stderr) => {
						if (error) {
							scoped
								.log("warn", {
									exitCode: error.code,
									stderr: stderr.trim(),
									message: "[ps-tree] ps exited non-zero",
								})
								.pipe(Effect.runSync);
							resolve(null);
							return;
						}
						resolve(stdout);
					});
				}),
			catch: (error) => new Error(`[ps-tree] ps invocation failed: ${String(error)}`),
		}).pipe(
			Effect.timeout(PS_TIMEOUT),
			Effect.catchAllCause((cause) =>
				Effect.gen(function* () {
					yield* scoped.log("warn", {
						cause: Cause.pretty(cause),
						message: "[ps-tree] ps invocation failed",
					});
					return null;
				}),
			),
		);
	});
}

/**
 * Parse `ps` output into a pid→row map. Each line is
 * `PID PPID %CPU RSS` (whitespace separated). Header rows are skipped for darwin.
 */
export function parsePsOutput(output: string, platform: "linux" | "darwin" = "linux"): Map<number, PsRow> {
	const table = new Map<number, PsRow>();
	let skipHeader = platform === "darwin";
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (skipHeader) {
			skipHeader = false;
			continue;
		}
		const parts = trimmed.split(/\s+/);
		if (parts.length < 4) continue;
		const pid = Number.parseInt(parts[0], 10);
		const ppid = Number.parseInt(parts[1], 10);
		const cpu = Number.parseFloat(parts[2]);
		const rss = Number.parseInt(parts[3], 10) * 1024;
		if (Number.isNaN(pid) || Number.isNaN(ppid) || Number.isNaN(cpu) || Number.isNaN(rss)) {
			continue;
		}
		table.set(pid, { pid, ppid, cpu, rss });
	}
	return table;
}

export function buildChildrenIndex(table: Map<number, PsRow>): Map<number, number[]> {
	const children = new Map<number, number[]>();
	for (const row of table.values()) {
		const list = children.get(row.ppid);
		if (list) list.push(row.pid);
		else children.set(row.ppid, [row.pid]);
	}
	return children;
}

export function getDescendantPids(
	rootPid: number,
	_table: Map<number, PsRow>,
	children: Map<number, number[]>,
): number[] {
	const descendants: number[] = [];
	const seen = new Set<number>([rootPid]);
	const queue: number[] = [rootPid];
	while (queue.length > 0) {
		const pid = queue.shift() as number;
		const kids = children.get(pid);
		if (!kids) continue;
		for (const kid of kids) {
			if (seen.has(kid)) continue;
			seen.add(kid);
			descendants.push(kid);
			queue.push(kid);
		}
	}
	return descendants;
}

export interface ProcessMetricsSample {
	pid: number;
	cpuPercent: number;
	rssBytes: number;
	timestamp: number;
}

/**
 * Walk the process tree rooted at each `rootPid`, summing cpu% and rss across
 * the root and all of its descendants. Returns one sample per root pid.
 */
export function sampleMetrics(rootPids: number[]) {
	return Effect.gen(function* () {
		if (rootPids.length === 0) return [];
		const output = yield* runPs();
		if (output === null) return [];
		const table = parsePsOutput(output);
		const children = buildChildrenIndex(table);
		const timestamp = Date.now();
		const samples: ProcessMetricsSample[] = [];
		for (const rootPid of rootPids) {
			if (!table.has(rootPid)) continue;
			let cpu = 0;
			let rss = 0;
			const seen = new Set<number>();
			const queue: number[] = [rootPid];
			while (queue.length > 0) {
				const pid = queue.shift() as number;
				if (seen.has(pid)) continue;
				seen.add(pid);
				const row = table.get(pid);
				if (!row) continue;
				cpu += row.cpu;
				rss += row.rss;
				const kids = children.get(pid);
				if (kids) queue.push(...kids);
			}
			samples.push({ pid: rootPid, cpuPercent: cpu, rssBytes: rss, timestamp });
		}
		return samples;
	});
}
