import type { AgentMessage } from "@piki/agent-core";
import type { ImageContent, TextContent } from "@piki/ai";
import chalk from "chalk";
import { writeFile } from "fs/promises";
import { ENV_SESSION_DIR, expandTildePath } from "./config.ts";
import { bashExecutionToText } from "./core/messages.ts";
import { type SessionEntry, type SessionInfo, SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { normalizePath, resolvePath } from "./utils/paths.ts";

type ExportFormat = "markdown" | "json";

interface SessionsOptions {
	sessionDir?: string;
}

interface SearchCriteria {
	keywords: string[];
	after?: Date;
	before?: Date;
	cwd?: string;
	name?: string;
	limit: number;
}

interface ResolvedSession {
	info: SessionInfo;
}

function printSessionsHelp(): void {
	console.log(`${chalk.bold("pi sessions")} - search and export saved sessions

${chalk.bold("Usage:")}
  pi sessions search [query...] [--limit <n>] [--session-dir <dir>]
  pi sessions export <id|path> [--format markdown|json] [--output <file>] [--session-dir <dir>]

${chalk.bold("Search filters:")}
  after:<date>      Include sessions modified on or after date
  before:<date>     Include sessions modified on or before date
  cwd:<path>        Match session cwd substring
  name:<text>       Match session display name substring

${chalk.bold("Examples:")}
  pi sessions search auth after:2026-01-01
  pi sessions export 018f --format markdown --output session.md
`);
}

function parseDateFilter(value: string, label: string): Date {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`${label} must be a valid date`);
	}
	return date;
}

function parseSearchArgs(args: string[]): { criteria: SearchCriteria; options: SessionsOptions } {
	const criteria: SearchCriteria = { keywords: [], limit: 20 };
	const options: SessionsOptions = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--limit") {
			const value = args[++i];
			const limit = Number.parseInt(value ?? "", 10);
			if (!Number.isFinite(limit) || limit < 1) {
				throw new Error("--limit requires a positive integer");
			}
			criteria.limit = limit;
		} else if (arg === "--session-dir") {
			const value = args[++i];
			if (!value) throw new Error("--session-dir requires a value");
			options.sessionDir = normalizePath(value);
		} else if (arg.startsWith("after:")) {
			criteria.after = parseDateFilter(arg.slice("after:".length), "after");
		} else if (arg.startsWith("before:")) {
			criteria.before = parseDateFilter(arg.slice("before:".length), "before");
		} else if (arg.startsWith("cwd:")) {
			criteria.cwd = arg.slice("cwd:".length);
		} else if (arg.startsWith("name:")) {
			criteria.name = arg.slice("name:".length);
		} else if (arg === "--help" || arg === "-h") {
			printSessionsHelp();
			process.exit(0);
		} else {
			criteria.keywords.push(arg);
		}
	}

	return { criteria, options };
}

function parseExportArgs(args: string[]): {
	target: string;
	format: ExportFormat;
	output?: string;
	options: SessionsOptions;
} {
	let target: string | undefined;
	let format: ExportFormat = "markdown";
	let output: string | undefined;
	const options: SessionsOptions = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--format") {
			const value = args[++i];
			if (value !== "markdown" && value !== "json") {
				throw new Error("--format must be markdown or json");
			}
			format = value;
		} else if (arg === "--output") {
			output = args[++i];
			if (!output) throw new Error("--output requires a value");
		} else if (arg === "--session-dir") {
			const value = args[++i];
			if (!value) throw new Error("--session-dir requires a value");
			options.sessionDir = normalizePath(value);
		} else if (arg === "--help" || arg === "-h") {
			printSessionsHelp();
			process.exit(0);
		} else if (!target) {
			target = arg;
		} else {
			throw new Error(`Unexpected argument: ${arg}`);
		}
	}

	if (!target) {
		throw new Error("sessions export requires a session id or path");
	}

	return { target, format, output, options };
}

function getConfiguredSessionDir(cwd: string, explicitSessionDir?: string): string | undefined {
	if (explicitSessionDir) return explicitSessionDir;
	const envSessionDir = process.env[ENV_SESSION_DIR];
	if (envSessionDir) return expandTildePath(envSessionDir);
	return SettingsManager.create(cwd).getSessionDir();
}

function matchesCriteria(session: SessionInfo, criteria: SearchCriteria): boolean {
	if (criteria.after && session.modified < criteria.after) return false;
	if (criteria.before && session.modified > criteria.before) return false;
	if (criteria.cwd && !session.cwd.toLowerCase().includes(criteria.cwd.toLowerCase())) return false;
	if (criteria.name && !(session.name ?? "").toLowerCase().includes(criteria.name.toLowerCase())) return false;

	const haystack = [session.id, session.cwd, session.name ?? "", session.firstMessage, session.allMessagesText]
		.join("\n")
		.toLowerCase();
	return criteria.keywords.every((keyword) => haystack.includes(keyword.toLowerCase()));
}

function truncate(value: string, max: number): string {
	const clean = value.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function printSearchResults(sessions: SessionInfo[]): void {
	if (sessions.length === 0) {
		console.log(chalk.dim("No sessions found."));
		return;
	}

	for (const session of sessions) {
		const title = session.name ?? (truncate(session.firstMessage, 72) || "(untitled)");
		console.log(`${chalk.bold(session.id)}  ${session.modified.toISOString()}  ${title}`);
		console.log(chalk.dim(`  cwd: ${session.cwd || "(unknown)"}`));
		console.log(chalk.dim(`  path: ${session.path}`));
	}
}

function contentBlocksToMarkdown(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.map((item) => {
			if (item.type === "text") return item.text;
			return `[image: ${item.mimeType}]`;
		})
		.join("\n");
}

function messageToMarkdown(message: AgentMessage): string {
	if (message.role === "user") {
		return `## User\n\n${contentBlocksToMarkdown(message.content)}`;
	}
	if (message.role === "assistant") {
		const blocks = message.content.map((item) => {
			if (item.type === "text") return item.text;
			if (item.type === "thinking") return `<details><summary>Thinking</summary>\n\n${item.thinking}\n\n</details>`;
			return `\`\`\`json\n${JSON.stringify({ tool: item.name, arguments: item.arguments }, null, 2)}\n\`\`\``;
		});
		return `## Assistant\n\n${blocks.join("\n\n")}`;
	}
	if (message.role === "toolResult") {
		return `## Tool Result: ${message.toolName}\n\n${contentBlocksToMarkdown(message.content)}`;
	}
	if (message.role === "bashExecution") {
		return `## Bash\n\n${bashExecutionToText(message)}`;
	}
	if (message.role === "custom") {
		return `## Custom: ${message.customType}\n\n${contentBlocksToMarkdown(message.content)}`;
	}
	if (message.role === "branchSummary") {
		return `## Branch Summary\n\n${message.summary}`;
	}
	return `## Compaction Summary\n\n${message.summary}`;
}

function entryToMarkdown(entry: SessionEntry): string | undefined {
	if (entry.type === "message") return messageToMarkdown(entry.message);
	if (entry.type === "custom_message")
		return `## Custom: ${entry.customType}\n\n${contentBlocksToMarkdown(entry.content)}`;
	if (entry.type === "compaction") return `## Compaction\n\n${entry.summary}`;
	if (entry.type === "branch_summary") return `## Branch Summary\n\n${entry.summary}`;
	if (entry.type === "model_change") return `## Model Change\n\n${entry.provider}/${entry.modelId}`;
	if (entry.type === "thinking_level_change") return `## Thinking Level Change\n\n${entry.thinkingLevel}`;
	return undefined;
}

function renderMarkdown(session: SessionManager): string {
	const header = session.getHeader();
	const title = session.getSessionName() ?? header?.id ?? "session";
	const sections = session
		.getEntries()
		.map(entryToMarkdown)
		.filter((section): section is string => section !== undefined);
	const metadata = [
		`# ${title}`,
		"",
		`- ID: ${header?.id ?? session.getSessionId()}`,
		`- CWD: ${header?.cwd ?? session.getCwd()}`,
		`- Created: ${header?.timestamp ?? "unknown"}`,
		"",
	];
	return `${metadata.join("\n")}${sections.join("\n\n")}\n`;
}

function renderJson(session: SessionManager): string {
	return `${JSON.stringify({ header: session.getHeader(), entries: session.getEntries() }, null, 2)}\n`;
}

async function resolveSession(target: string, sessionDir?: string): Promise<ResolvedSession> {
	const isPath = target.includes("/") || target.includes("\\") || target.endsWith(".jsonl");
	if (isPath) {
		const path = resolvePath(target);
		const info = (await SessionManager.listAll(sessionDir)).find((session) => session.path === path);
		return {
			info: info ?? {
				path,
				id: path,
				cwd: "",
				created: new Date(0),
				modified: new Date(0),
				messageCount: 0,
				firstMessage: "",
				allMessagesText: "",
			},
		};
	}

	const sessions = await SessionManager.listAll(sessionDir);
	const exact = sessions.find((session) => session.id === target);
	if (exact) return { info: exact };
	const matches = sessions.filter((session) => session.id.startsWith(target));
	if (matches.length === 1 && matches[0]) return { info: matches[0] };
	if (matches.length > 1) {
		throw new Error(`Session id '${target}' is ambiguous (${matches.map((session) => session.id).join(", ")})`);
	}
	throw new Error(`No session found matching '${target}'`);
}

async function handleSearch(args: string[], cwd: string): Promise<void> {
	const { criteria, options } = parseSearchArgs(args);
	const sessionDir = getConfiguredSessionDir(cwd, options.sessionDir);
	const sessions = (await SessionManager.listAll(sessionDir))
		.filter((session) => matchesCriteria(session, criteria))
		.slice(0, criteria.limit);
	printSearchResults(sessions);
}

async function handleExport(args: string[], cwd: string): Promise<void> {
	const { target, format, output, options } = parseExportArgs(args);
	const sessionDir = getConfiguredSessionDir(cwd, options.sessionDir);
	const resolved = await resolveSession(target, sessionDir);
	const session = SessionManager.open(resolved.info.path, sessionDir);
	const rendered = format === "json" ? renderJson(session) : renderMarkdown(session);
	if (output) {
		await writeFile(resolvePath(output, cwd), rendered);
		console.log(`Exported to: ${resolvePath(output, cwd)}`);
	} else {
		process.stdout.write(rendered);
	}
}

export async function handleSessionsCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "sessions") return false;

	const cwd = process.cwd();
	const command = args[1];
	try {
		if (!command || command === "--help" || command === "-h") {
			printSessionsHelp();
		} else if (command === "search") {
			await handleSearch(args.slice(2), cwd);
		} else if (command === "export") {
			await handleExport(args.slice(2), cwd);
		} else {
			throw new Error(`Unknown sessions command: ${command}`);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
	}

	return true;
}
