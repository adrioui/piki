import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getTasteDir } from "../config.ts";

/**
 * Taste signal type — mirrors Command Code's accept/reject/edit learning model.
 *
 * Every assistant turn produces a taste observation. The signal type records
 * what the user did with the agent's changes:
 * - "accept": changes were kept as-is into the next turn
 * - "reject": changes were reverted before the next turn
 * - "edit": changes were modified by the user before the next turn
 * - "observe": baseline observation (no file-change signal available)
 */
export type TasteSignalType = "accept" | "reject" | "edit" | "observe";

export interface TasteObservation {
	timestamp: string;
	sessionId: string;
	cwd: string;
	userText?: string;
	assistantText?: string;
	toolNames: string[];
	retryCount: number;
	stopReason?: string;
	model?: {
		provider: string;
		id: string;
	};
	/** Continuous learning signal type (Command Code parity). */
	signalType: TasteSignalType;
	/** Files that changed (for accept/reject/edit signals). */
	changedFiles?: string[];
	/** Brief diff summary (for edit signals). */
	diffSummary?: string;
}

export interface TasteStatus {
	workspaceDir: string;
	profilePath: string;
	observationsPath: string;
	profileEntryCount: number;
	observationCount: number;
}

export interface TasteLintResult extends TasteStatus {
	valid: boolean;
	errors: string[];
}

export interface TasteLearnResult extends TasteStatus {
	updated: boolean;
	writtenEntries: string[];
}

export type TasteScope = "auto" | "project" | "global";

const TASTE_LINE_PATTERN = /^- .+?\s+confidence:\s*(0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/i;
const LEGACY_TASTE_LINE_PATTERN = /^- (.+?)\. Confidence: (0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/;

function workspaceSlug(cwd: string): string {
	const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
	const name = basename(cwd).replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace";
	return `${name}-${hash}`;
}

export function normalizeTasteLines(lines: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		const migrated = trimmed.replace(LEGACY_TASTE_LINE_PATTERN, "- $1. confidence: $2");
		if (migrated.startsWith("# ")) {
			normalized.push(migrated);
			continue;
		}
		if (!TASTE_LINE_PATTERN.test(migrated)) continue;
		if (seen.has(migrated)) continue;
		seen.add(migrated);
		normalized.push(migrated);
	}
	return normalized;
}

function parseTasteLines(content: string): string[] {
	return normalizeTasteLines(content.split("\n"));
}

function tasteSignalWeight(signalType: TasteSignalType): number {
	switch (signalType) {
		case "accept":
			return 1.15;
		case "edit":
			return 1.05;
		case "observe":
			return 1;
		case "reject":
			return 0.7;
	}
}

function clampConfidence(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function adjustTasteLineConfidence(line: string, weight: number): string {
	const match = line.match(/^(.*confidence:\s*)(0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/i);
	if (!match) return line;
	const adjusted = clampConfidence(Number.parseFloat(match[2]) * weight);
	return `${match[1]}${adjusted.toFixed(2)}`;
}

export function findLookaheadEnd(lines: string[], startIndex: number): number {
	for (let index = startIndex + 1; index < lines.length; index++) {
		if (lines[index]?.startsWith("# ")) return index;
	}
	return lines.length;
}

function categorySlug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "general"
	);
}

function toCategorizedMarkdown(content: string): string {
	const lines = parseTasteLines(content);
	if (lines.length === 0) return "";
	if (lines.some((line) => line.startsWith("# "))) return `${lines.join("\n")}\n`;
	return `${["# General", ...lines].join("\n")}\n`;
}

function countJsonlRecords(path: string): number {
	if (!existsSync(path)) return 0;
	return readFileSync(path, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0).length;
}

function readJsonlTail(path: string, limit: number): string[] {
	const size = statSync(path).size;
	let bytesToRead = Math.min(size, 1024 * 1024);
	while (bytesToRead < size) {
		const tail = readFileTail(path, bytesToRead);
		const lines = tail
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (lines.length >= limit) return lines.slice(-limit);
		bytesToRead = Math.min(size, bytesToRead * 2);
	}
	return readFileTail(path, bytesToRead)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(-limit);
}

function readFileTail(path: string, bytesToRead: number): string {
	const size = statSync(path).size;
	const start = Math.max(0, size - bytesToRead);
	const buffer = Buffer.alloc(size - start);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, buffer.length, start);
	} finally {
		closeSync(fd);
	}
	const text = buffer.toString("utf-8");
	if (start === 0) return text;
	const firstNewline = text.indexOf("\n");
	return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
}

export class TasteProfileStore {
	private readonly baseDir: string;
	private readonly scope: TasteScope;

	constructor(baseDir = getTasteDir(), scope: TasteScope = "auto") {
		this.baseDir = baseDir;
		this.scope = scope;
	}

	getProjectDir(cwd: string): string {
		return join(cwd, ".piki", "taste");
	}

	getWorkspaceDir(cwd: string): string {
		const projectDir = this.getProjectDir(cwd);
		if (this.scope === "project" || (this.scope === "auto" && existsSync(projectDir))) {
			return projectDir;
		}
		return join(this.baseDir, workspaceSlug(cwd));
	}

	getProfilePath(cwd: string): string {
		return join(this.getWorkspaceDir(cwd), "taste.md");
	}

	getObservationsPath(cwd: string): string {
		return join(this.getWorkspaceDir(cwd), "observations.jsonl");
	}

	ensureWorkspace(cwd: string): void {
		const folder = this.getWorkspaceDir(cwd);
		if (!existsSync(folder)) {
			mkdirSync(folder, { recursive: true });
		}
	}

	getProfile(cwd: string): string | undefined {
		const path = this.getProfilePath(cwd);
		if (!existsSync(path)) return undefined;
		const content = readFileSync(path, "utf-8");
		const migrated = toCategorizedMarkdown(content);
		return (migrated || content).trim() || undefined;
	}

	renderInjectedProfile(cwd: string, limit = 12): string | undefined {
		const content = this.getProfile(cwd);
		if (!content) return undefined;
		const lines = parseTasteLines(content)
			.filter((line) => !line.startsWith("# "))
			.slice(0, limit);
		if (lines.length === 0) return undefined;
		return [
			"<taste_profile>",
			"Apply these learned user preferences when they help:",
			...lines,
			"</taste_profile>",
		].join("\n");
	}

	recordObservation(observation: TasteObservation): void {
		this.ensureWorkspace(observation.cwd);
		appendFileSync(this.getObservationsPath(observation.cwd), `${JSON.stringify(observation)}\n`);
	}

	status(cwd: string): TasteStatus {
		this.ensureWorkspace(cwd);
		return {
			workspaceDir: this.getWorkspaceDir(cwd),
			profilePath: this.getProfilePath(cwd),
			observationsPath: this.getObservationsPath(cwd),
			profileEntryCount: parseTasteLines(this.getProfile(cwd) ?? "").filter((line) => !line.startsWith("# ")).length,
			observationCount: countJsonlRecords(this.getObservationsPath(cwd)),
		};
	}

	lint(cwd: string): TasteLintResult {
		const path = this.getProfilePath(cwd);
		const profile = existsSync(path) ? readFileSync(path, "utf-8") : "";
		const status = this.status(cwd);
		const errors = profile
			.split("\n")
			.map((line) => line.trim())
			.filter(
				(line) =>
					line.length > 0 &&
					!line.startsWith("# ") &&
					!TASTE_LINE_PATTERN.test(line) &&
					!LEGACY_TASTE_LINE_PATTERN.test(line),
			)
			.map((line) => `Invalid taste entry: ${line}`);
		return {
			...status,
			valid: errors.length === 0,
			errors,
		};
	}

	reorganize(cwd: string): TasteLearnResult {
		const status = this.status(cwd);
		const observations = this.readLatestObservations(cwd, 200);
		const signalWeight =
			observations.length === 0
				? 1
				: observations.reduce((sum, observation) => sum + tasteSignalWeight(observation.signalType), 0) /
					observations.length;
		const lines = parseTasteLines(this.getProfile(cwd) ?? "")
			.filter((line) => !line.startsWith("# "))
			.map((line) => adjustTasteLineConfidence(line, signalWeight))
			.sort((left, right) => left.localeCompare(right));
		const content = ["# General", ...lines].join("\n") + (lines.length > 0 ? "\n" : "");
		this.ensureWorkspace(cwd);
		writeFileSync(status.profilePath, content);
		this.writeCategoryFiles(cwd, content);
		return {
			...status,
			updated: true,
			writtenEntries: lines,
		};
	}

	readLatestObservations(cwd: string, limit = 40): TasteObservation[] {
		const path = this.getObservationsPath(cwd);
		if (!existsSync(path)) return [];
		return readJsonlTail(path, limit).map((line) => JSON.parse(line) as TasteObservation);
	}

	listProfiles(): Array<{ name: string; path: string; scope: "global" | "project" }> {
		const profiles: Array<{ name: string; path: string; scope: "global" | "project" }> = [];
		if (!existsSync(this.baseDir)) return profiles;
		for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(this.baseDir, entry.name, "taste.md");
			if (existsSync(path)) {
				profiles.push({ name: entry.name, path, scope: "global" });
			}
		}
		return profiles;
	}

	writeCategoryFiles(cwd: string, content: string): void {
		const lines = content.split("\n");
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]?.trim();
			if (!line?.startsWith("# ")) continue;
			const end = findLookaheadEnd(lines, index);
			const entries = normalizeTasteLines(lines.slice(index + 1, end)).filter((entry) => !entry.startsWith("# "));
			if (entries.length === 0) continue;
			const dir = join(this.getWorkspaceDir(cwd), categorySlug(line.slice(2)));
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "taste.md"), `${line}\n${entries.join("\n")}\n`);
		}
	}
}
