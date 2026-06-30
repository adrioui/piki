/**
 * Cross-Agent Session Importer - Phase 4.
 *
 * Discovers sessions from 7 agents (Claude Code, Codex, Cursor, Aider,
 * Cline, Pi Agent, Factory), extracts user prompts in batches (150K char
 * limit), and sends them to the taste learning pipeline.
 *
 * Tracks learned/skipped sessions per agent in onboarding state.
 * Mirrors Command-Code's cross-agent taste learning: the system imports
 * user preferences from other coding agents to bootstrap the taste profile.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentId = "claude-code" | "codex" | "cursor" | "aider" | "cline" | "pi-agent" | "factory";

export interface DiscoveredSession {
	agent: AgentId;
	/** Path to the session file. */
	path: string;
	/** Session file modification time (for sorting by recency). */
	mtime: number;
	/** Extracted user prompts from the session. */
	prompts: string[];
}

export interface SessionImportResult {
	agent: AgentId;
	discovered: number;
	learned: number;
	skipped: number;
	promptBatches: number;
	errors: string[];
}

export interface OnboardingState {
	learned: Partial<Record<AgentId, { sessionPaths: string[]; lastImportAt: string }>>;
}

export const MAX_BATCH_CHARS = 150_000;

interface AgentFinder {
	agent: AgentId;
	/** Discover session files for this agent. */
	discover(): string[];
	/** Extract user prompts from a session file. */
	extractPrompts(path: string): string[];
}

const HOME = homedir();

/**
 * Read a JSONL file and return parsed lines.
 */
function readJsonl(path: string): unknown[] {
	try {
		return readFileSync(path, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => {
				try {
					return JSON.parse(line) as unknown;
				} catch {
					return null;
				}
			})
			.filter((entry): entry is unknown => entry !== null);
	} catch {
		return [];
	}
}

function safeReaddir(dir: string, recursive: boolean): string[] {
	if (!existsSync(dir)) return [];
	const results: string[] = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory() && recursive) {
				results.push(...safeReaddir(fullPath, true));
			} else if (entry.isFile()) {
				results.push(fullPath);
			}
		}
	} catch {
		return [];
	}
	return results;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part) {
					return String((part as { text: unknown }).text);
				}
				return "";
			})
			.join("\n")
			.trim();
	}
	return "";
}

// --- Agent finders ---

const claudeCodeFinder: AgentFinder = {
	agent: "claude-code",
	discover: () => {
		const dir = join(HOME, ".claude", "projects");
		return safeReaddir(dir, true).filter((p) => p.endsWith(".jsonl"));
	},
	extractPrompts: (path) => {
		const lines = readJsonl(path);
		return lines
			.filter((entry) => {
				const obj = entry as Record<string, unknown>;
				return obj.type === "human" || (obj.role === "user" && obj.message);
			})
			.map((entry) => {
				const obj = entry as Record<string, unknown>;
				if (obj.message) return extractText((obj.message as Record<string, unknown>).content);
				return extractText(obj.content);
			})
			.filter((text) => text.length > 0);
	},
};

const codexFinder: AgentFinder = {
	agent: "codex",
	discover: () => {
		const dir = join(HOME, ".codex", "sessions");
		return safeReaddir(dir, true).filter((p) => p.endsWith(".jsonl") || p.endsWith(".json"));
	},
	extractPrompts: (path) => {
		if (path.endsWith(".json")) {
			try {
				const data = JSON.parse(readFileSync(path, "utf-8")) as unknown;
				const messages = (data as Record<string, unknown>)?.messages;
				if (Array.isArray(messages)) {
					return messages
						.filter((m) => (m as Record<string, unknown>).role === "user")
						.map((m) => extractText((m as Record<string, unknown>).content))
						.filter((t) => t.length > 0);
				}
			} catch {
				return [];
			}
		}
		return readJsonl(path)
			.filter((entry) => (entry as Record<string, unknown>).role === "user")
			.map((entry) => extractText((entry as Record<string, unknown>).content))
			.filter((t) => t.length > 0);
	},
};

const cursorFinder: AgentFinder = {
	agent: "cursor",
	discover: () => {
		const dir = join(HOME, ".cursor", "chat-sessions");
		return safeReaddir(dir, true).filter((p) => p.endsWith(".json"));
	},
	extractPrompts: (path) => {
		try {
			const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
			const messages = data.messages;
			if (Array.isArray(messages)) {
				return messages
					.filter((m) => (m as Record<string, unknown>).role === "user")
					.map((m) => extractText((m as Record<string, unknown>).text ?? (m as Record<string, unknown>).content))
					.filter((t) => t.length > 0);
			}
		} catch {
			return [];
		}
		return [];
	},
};

const aiderFinder: AgentFinder = {
	agent: "aider",
	discover: () => {
		// Aider stores chat history in project directories as .aider.chat.history.md
		const results: string[] = [];
		const commonDirs = [join(HOME, "Projects"), join(HOME, "code"), join(HOME, "dev"), process.cwd()];
		for (const dir of commonDirs) {
			if (!existsSync(dir)) continue;
			for (const entry of safeReaddir(dir, true)) {
				if (entry.endsWith(".aider.chat.history.md") || entry.endsWith("aider.chat.history.md")) {
					results.push(entry);
				}
			}
		}
		return results;
	},
	extractPrompts: (path) => {
		try {
			const content = readFileSync(path, "utf-8");
			// Aider markdown format: #### lines are user messages
			return content
				.split("\n#### ")
				.slice(1)
				.map((block) => block.split("\n").slice(0, 20).join("\n").trim())
				.filter((t) => t.length > 0);
		} catch {
			return [];
		}
	},
};

const clineFinder: AgentFinder = {
	agent: "cline",
	discover: () => {
		// Cline (VS Code extension) stores task files in globalStorage
		const dirs = [
			join(HOME, ".vscode", "extensions", "saoudrizwan.claude-dev"),
			join(HOME, ".vscode-server", "data", "User", "globalStorage", "saoudrizwan.claude-dev"),
		];
		const results: string[] = [];
		for (const dir of dirs) {
			results.push(...safeReaddir(dir, true).filter((p) => p.endsWith(".json")));
		}
		return results;
	},
	extractPrompts: (path) => {
		try {
			const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
			const messages = data.messages;
			if (Array.isArray(messages)) {
				return messages
					.filter(
						(m) =>
							(m as Record<string, unknown>).role === "user" || (m as Record<string, unknown>).say === "user",
					)
					.map((m) => extractText((m as Record<string, unknown>).text ?? (m as Record<string, unknown>).content))
					.filter((t) => t.length > 0);
			}
		} catch {
			return [];
		}
		return [];
	},
};

const piAgentFinder: AgentFinder = {
	agent: "pi-agent",
	discover: () => {
		// Pi agent stores sessions in .pi/sessions
		const dirs = [join(process.cwd(), ".pi", "sessions"), join(HOME, ".pi", "sessions")];
		const results: string[] = [];
		for (const dir of dirs) {
			results.push(...safeReaddir(dir, true).filter((p) => p.endsWith(".jsonl")));
		}
		return results;
	},
	extractPrompts: (path) =>
		readJsonl(path)
			.filter((entry) => (entry as Record<string, unknown>).role === "user")
			.map((entry) => extractText((entry as Record<string, unknown>).content))
			.filter((t) => t.length > 0),
};

const factoryFinder: AgentFinder = {
	agent: "factory",
	discover: () => {
		const dirs = [join(HOME, ".factory", "sessions"), join(process.cwd(), ".factory", "sessions")];
		const results: string[] = [];
		for (const dir of dirs) {
			results.push(...safeReaddir(dir, true).filter((p) => p.endsWith(".jsonl") || p.endsWith(".json")));
		}
		return results;
	},
	extractPrompts: (path) => {
		if (path.endsWith(".json")) {
			try {
				const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
				const messages = data.messages;
				if (Array.isArray(messages)) {
					return messages
						.filter((m) => (m as Record<string, unknown>).role === "user")
						.map((m) => extractText((m as Record<string, unknown>).content))
						.filter((t) => t.length > 0);
				}
			} catch {
				return [];
			}
		}
		return readJsonl(path)
			.filter((entry) => (entry as Record<string, unknown>).role === "user")
			.map((entry) => extractText((entry as Record<string, unknown>).content))
			.filter((t) => t.length > 0);
	},
};

const ALL_FINDERS: AgentFinder[] = [
	claudeCodeFinder,
	codexFinder,
	cursorFinder,
	aiderFinder,
	clineFinder,
	piAgentFinder,
	factoryFinder,
];

/**
 * Discover sessions from a specific agent (or all agents).
 */
export function discoverSessions(agent?: AgentId): DiscoveredSession[] {
	const finders = agent ? ALL_FINDERS.filter((f) => f.agent === agent) : ALL_FINDERS;
	const sessions: DiscoveredSession[] = [];

	for (const finder of finders) {
		const paths = finder.discover();
		for (const path of paths) {
			try {
				const stat = statSync(path);
				const prompts = finder.extractPrompts(path);
				if (prompts.length > 0) {
					sessions.push({ agent: finder.agent, path, mtime: stat.mtimeMs, prompts });
				}
			} catch {
				// Skip unreadable files
			}
		}
	}

	// Sort by recency (most recent first)
	return sessions.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Batch user prompts into chunks that fit within the 150K character limit.
 * Each batch is a single string of concatenated prompts, ready to send
 * to the taste learning pipeline.
 */
export function batchPrompts(prompts: string[], maxChars = MAX_BATCH_CHARS): string[] {
	const batches: string[] = [];
	let current = "";

	for (const prompt of prompts) {
		if (current.length + prompt.length + 2 > maxChars) {
			if (current) batches.push(current);
			current = prompt.length > maxChars ? prompt.slice(0, maxChars) : prompt;
		} else {
			current = current ? `${current}\n\n${prompt}` : prompt;
		}
	}

	if (current) batches.push(current);
	return batches;
}

/**
 * Extract all user prompts from discovered sessions, batched and ready
 * for the taste learning pipeline.
 */
export function extractBatchedPrompts(
	sessions: DiscoveredSession[],
	maxChars = MAX_BATCH_CHARS,
): Array<{ agent: AgentId; batches: string[]; sessionPath: string }> {
	return sessions.map((session) => ({
		agent: session.agent,
		sessionPath: session.path,
		batches: batchPrompts(session.prompts, maxChars),
	}));
}

/**
 * Read onboarding state from a JSON file.
 */
export function readOnboardingState(path: string): OnboardingState {
	if (!existsSync(path)) return { learned: {} };
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as OnboardingState;
	} catch {
		return { learned: {} };
	}
}

/**
 * Get the list of agents that have sessions available for import.
 */
export function getAvailableAgents(): AgentId[] {
	return ALL_FINDERS.map((f) => f.agent).filter((agent) => {
		const finder = ALL_FINDERS.find((f) => f.agent === agent)!;
		return finder.discover().length > 0;
	});
}
