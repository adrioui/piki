import { homedir } from "node:os";
import { join } from "node:path";
import { SCRATCHPAD_SUBDIRS, type ScratchpadSubdir } from "@piki/scratchpad";

export { SCRATCHPAD_SUBDIRS, type ScratchpadSubdir };

export function defaultGlobalStorageRoot(): string {
	return join(homedir(), ".piki");
}

export interface GlobalStoragePaths {
	root: string;
	configFile: string;
	authFile: string;
	sessionsRoot: string;
	pendingMemoryExtractionRoot: string;
	tracesRoot: string;
	logsRoot: string;
	cliLogFile: string;
	eventLogFile: string;
	skillsRoot: string;
	sessionDir: (sessionId: string) => string;
	sessionMetaFile: (sessionId: string) => string;
	sessionEventsFile: (sessionId: string) => string;
	sessionLogFile: (sessionId: string) => string;
	sessionScratchpad: (sessionId: string) => string;
	sessionScratchpadSubdir: (sessionId: string, subdir: ScratchpadSubdir) => string;
	pendingMemoryJobFile: (jobId: string) => string;
	traceDir: (traceId: string) => string;
	traceMetaFile: (traceId: string) => string;
	traceEventsFile: (traceId: string) => string;
	globalSkillDir: (skillName: string) => string;
	globalSkillFile: (skillName: string) => string;
}

export function makeGlobalStoragePaths(root: string): GlobalStoragePaths {
	const sessionsRoot = join(root, "sessions");
	const tracesRoot = join(root, "traces");
	const logsRoot = join(root, "logs");
	const skillsRoot = join(root, "skills");
	const pendingMemoryExtractionRoot = join(sessionsRoot, ".pending-memory-extraction");
	return {
		root,
		configFile: join(root, "config.json"),
		authFile: join(root, "auth.json"),
		sessionsRoot,
		pendingMemoryExtractionRoot,
		tracesRoot,
		logsRoot,
		cliLogFile: join(logsRoot, "cli.jsonl"),
		eventLogFile: join(logsRoot, "events.jsonl"),
		skillsRoot,
		sessionDir: (sessionId) => join(sessionsRoot, sessionId),
		sessionMetaFile: (sessionId) => join(sessionsRoot, sessionId, "meta.json"),
		sessionEventsFile: (sessionId) => join(sessionsRoot, sessionId, "events.jsonl"),
		sessionLogFile: (sessionId) => join(sessionsRoot, sessionId, "logs.jsonl"),
		sessionScratchpad: (sessionId) => join(sessionsRoot, sessionId, "scratchpad"),
		sessionScratchpadSubdir: (sessionId, subdir) => join(sessionsRoot, sessionId, "scratchpad", subdir),
		pendingMemoryJobFile: (jobId) => join(pendingMemoryExtractionRoot, `${jobId}.json`),
		traceDir: (traceId) => join(tracesRoot, traceId),
		traceMetaFile: (traceId) => join(tracesRoot, traceId, "meta.json"),
		traceEventsFile: (traceId) => join(tracesRoot, traceId, "traces.jsonl"),
		globalSkillDir: (skillName) => join(skillsRoot, skillName),
		globalSkillFile: (skillName) => join(skillsRoot, skillName, "SKILL.md"),
	};
}

export interface ProjectStoragePaths {
	cwd: string;
	root: string;
	memoryFile: string;
	tasksDir: string;
	taskDateDir: (date: string) => string;
	taskFile: (date: string, taskId: string) => string;
	skillsRoot: string;
	projectSkillDir: (skillName: string) => string;
	projectSkillFile: (skillName: string) => string;
}

export function makeProjectStoragePaths(cwd: string): ProjectStoragePaths {
	const root = join(cwd, ".piki");
	const skillsRoot = join(root, "skills");
	return {
		cwd,
		root,
		memoryFile: join(root, "memory.md"),
		tasksDir: join(root, "tasks"),
		taskDateDir: (date) => join(root, "tasks", date),
		taskFile: (date, taskId) => join(root, "tasks", date, `${taskId}.md`),
		skillsRoot,
		projectSkillDir: (skillName) => join(skillsRoot, skillName),
		projectSkillFile: (skillName) => join(skillsRoot, skillName, "SKILL.md"),
	};
}
