import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSessionServices } from "./agent-session-services.ts";
import { runAuxModelText } from "./aux-model.ts";
import { normalizeTasteLines, type TasteLearnResult, TasteProfileStore, type TasteScope } from "./taste.ts";

export interface TasteLearnOptions {
	source: string;
	maxCommits?: number;
	maxSignals?: number;
	branch?: string;
	destinationCwd?: string;
	scope?: TasteScope;
	services: AgentSessionServices;
	model?: Model<string>;
	sessionId?: string;
}

export interface TasteLearnFromSignalsOptions {
	signals: string[];
	destinationCwd: string;
	scope?: TasteScope;
	services: AgentSessionServices;
	model?: Model<string>;
	sessionId?: string;
	systemPrompt?: string;
}

function isRemoteSource(source: string): boolean {
	return /^(https?:|git@|ssh:)/.test(source);
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: "pipe",
	}).trim();
}

function resolveSource(source: string, branch?: string): { path: string; temporary: boolean } {
	if (!isRemoteSource(source)) return { path: resolvePath(source), temporary: false };
	const target = mkdtempSync(join(tmpdir(), "pi-taste-"));
	const args = ["clone", "--quiet", "--depth", "250"];
	if (branch) args.push("--branch", branch);
	args.push(source, target);
	try {
		execFileSync("git", args, { encoding: "utf-8", stdio: "pipe" });
	} catch (error) {
		rmSync(target, { recursive: true, force: true });
		throw error;
	}
	return { path: target, temporary: true };
}

function findGitRoot(cwd: string): string {
	return git(cwd, ["rev-parse", "--show-toplevel"]);
}

function extractSignals(repo: string, maxCommits: number, maxSignals: number, maxTotalChars = 50_000): string[] {
	const commits = git(repo, ["log", `--max-count=${maxCommits}`, "--format=%H"])
		.split("\n")
		.filter(Boolean);
	const signals: string[] = [];
	let totalChars = 0;
	for (const commit of commits) {
		if (signals.length >= maxSignals) break;
		if (totalChars >= maxTotalChars) break;
		const parent = git(repo, ["rev-list", "--parents", "-n", "1", commit]).split(" ")[1];
		if (!parent) continue;
		const remaining = maxTotalChars - totalChars;
		const diff = git(repo, ["diff", "--unified=20", "--no-color", parent, commit]).slice(
			0,
			Math.min(12000, remaining),
		);
		if (!diff.trim()) continue;
		const subject = git(repo, ["log", "-1", "--format=%s", commit]);
		signals.push([`Commit: ${subject}`, `Hash: ${commit}`, "Before/after diff:", diff].join("\n"));
		totalChars += diff.length;
	}
	return signals;
}

export async function runLearnPipeline(options: TasteLearnOptions): Promise<TasteLearnResult> {
	const maxCommits = options.maxCommits ?? 200;
	const maxSignals = options.maxSignals ?? 50;
	const source = resolveSource(options.source, options.branch);
	try {
		const repo = findGitRoot(source.path);
		const destinationCwd = options.destinationCwd ?? (source.temporary ? process.cwd() : repo);
		const signals = extractSignals(repo, maxCommits, maxSignals);
		return await runLearnPipelineFromSignals({
			signals,
			destinationCwd,
			scope: options.scope ?? "project",
			services: options.services,
			model: options.model,
			sessionId: options.sessionId,
		});
	} finally {
		if (source.temporary) {
			rmSync(source.path, { recursive: true, force: true });
		}
	}
}

export async function runLearnPipelineFromSignals(options: TasteLearnFromSignalsOptions): Promise<TasteLearnResult> {
	const store = new TasteProfileStore(undefined, options.scope ?? "project");
	const status = store.status(options.destinationCwd);
	const signals = options.signals.map((signal) => signal.trim()).filter((signal) => signal.length > 0);
	if (signals.length === 0) {
		return { ...status, updated: false, writtenEntries: [] };
	}
	const content = await runAuxModelText({
		services: options.services,
		model: options.model,
		sessionId: options.sessionId,
		systemPrompt:
			options.systemPrompt ??
			[
				"You infer durable coding taste from git history.",
				"Use only evidence from before/after diffs.",
				"Return Command-Code markdown only:",
				"# Code Style",
				"- <rule>. confidence: <0.00-1.00>",
				"Group rules under concise # headers. Capture no secrets or one-off task facts.",
			].join("\n"),
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: signals.join("\n\n---\n\n") }],
				timestamp: Date.now(),
			} satisfies Message,
		],
	});
	const normalized = normalizeTasteLines(content.split("\n"));
	if (normalized.length === 0) {
		return { ...status, updated: false, writtenEntries: [] };
	}
	const output = normalized.some((line) => line.startsWith("# "))
		? `${normalized.join("\n")}\n`
		: `# General\n${normalized.join("\n")}\n`;
	store.ensureWorkspace(options.destinationCwd);
	const profilePath = store.getProfilePath(options.destinationCwd);
	writeFileSync(profilePath, output);
	store.writeCategoryFiles(options.destinationCwd, output);
	return {
		...store.status(options.destinationCwd),
		updated: true,
		writtenEntries: normalized.filter((line) => line.startsWith("- ")),
	};
}
