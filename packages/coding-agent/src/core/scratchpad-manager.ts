/**
 * Hierarchical Scratchpad Manager - Phase 5
 *
 * Creates a structured hierarchy for durable artifacts produced during agent sessions.
 * Hierarchical scratchpad organization:
 * - designs/: Architecture decisions, system designs, component specifications
 * - plans/: Implementation plans, migration strategies, task breakdowns
 * - reports/: Analysis reports, audit findings, investigation summaries
 * - results/: Test results, benchmark outputs, validation artifacts
 *
 * Each artifact is timestamped and tagged with session metadata for traceability.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ScratchpadCategory = "designs" | "plans" | "reports" | "results" | "thoughts" | "processes";

export interface ScratchpadArtifact {
	/** Artifact title */
	title: string;
	/** Category directory */
	category: ScratchpadCategory;
	/** Full artifact content */
	content: string;
	/** Optional tags for filtering */
	tags?: string[];
	/** Optional metadata */
	metadata?: Record<string, unknown>;
}

export interface ScratchpadConfig {
	/** Root directory for the scratchpad (default: .piki/scratchpad) */
	rootDir?: string;
	/** Whether to auto-create scratchpad directories on first use */
	autoCreate?: boolean;
}

export interface ScratchpadEntry {
	/** Full path to the artifact file */
	path: string;
	/** Artifact metadata from frontmatter */
	metadata: {
		title: string;
		category: ScratchpadCategory;
		timestamp: string;
		sessionId?: string;
		tags?: string[];
		[key: string]: unknown;
	};
	/** Artifact content (after frontmatter) */
	content: string;
}

/**
 * Generate a timestamp-based filename for an artifact.
 * Format: YYYYMMDD-HHMMSS-kebab-case-title.md
 */
function generateArtifactFilename(title: string, timestamp: Date = new Date()): string {
	const date = timestamp.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	return `${date}-${slug}.md`;
}

function generateJsonFilename(title: string, timestamp: Date = new Date()): string {
	return generateArtifactFilename(title, timestamp).replace(/\.md$/, ".json");
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter, body } or { frontmatter: {}, body: content } if no frontmatter.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	if (!content.startsWith("---\n")) {
		return { frontmatter: {}, body: content };
	}

	const endIndex = content.indexOf("\n---", 4);
	if (endIndex === -1) {
		return { frontmatter: {}, body: content };
	}

	const yamlContent = content.slice(4, endIndex);
	const body = content.slice(endIndex + 4).trim();

	// Simple YAML parser for flat key-value pairs
	const frontmatter: Record<string, unknown> = {};
	for (const line of yamlContent.split("\n")) {
		const match = line.match(/^(\w+):\s*(.+)$/);
		if (match) {
			const [, key, value] = match;
			// Parse arrays like [tag1, tag2]
			if (value.startsWith("[") && value.endsWith("]")) {
				frontmatter[key] = value
					.slice(1, -1)
					.split(",")
					.map((v) => v.trim());
			} else {
				frontmatter[key] = value.replace(/^["']|["']$/g, "");
			}
		}
	}

	return { frontmatter, body };
}

/**
 * Escape a string value for safe inclusion in a double-quoted YAML string.
 */
function escapeYamlString(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}

/**
 * Serialize metadata to YAML frontmatter.
 */
function serializeFrontmatter(metadata: Record<string, unknown>): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(metadata)) {
		if (Array.isArray(value)) {
			lines.push(`${key}: [${value.join(", ")}]`);
		} else if (typeof value === "string") {
			lines.push(`${key}: "${escapeYamlString(value)}"`);
		} else {
			lines.push(`${key}: ${value}`);
		}
	}
	lines.push("---");
	return lines.join("\n");
}

export class ScratchpadManager {
	private rootDir: string;
	private autoCreate: boolean;
	private sessionId?: string;

	constructor(config: ScratchpadConfig = {}) {
		this.rootDir = config.rootDir || join(process.cwd(), ".piki", "scratchpad");
		this.autoCreate = config.autoCreate ?? true;
	}

	/** Set the current session ID for artifact metadata */
	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	/**
	 * Ensure all scratchpad directories exist.
	 */
	initialize(): void {
		if (!this.autoCreate && !existsSync(this.rootDir)) {
			return;
		}

		const categories: ScratchpadCategory[] = ["designs", "plans", "reports", "results", "thoughts", "processes"];

		// Create root directory
		if (!existsSync(this.rootDir)) {
			mkdirSync(this.rootDir, { recursive: true });
		}

		// Create category directories
		for (const category of categories) {
			const dir = join(this.rootDir, category);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
		}
	}

	/**
	 * Save an artifact to the scratchpad.
	 * Returns the full path to the saved file.
	 */
	save(artifact: ScratchpadArtifact): string {
		this.initialize();

		const categoryDir = join(this.rootDir, artifact.category);
		if (!existsSync(categoryDir)) {
			mkdirSync(categoryDir, { recursive: true });
		}

		let filename = generateArtifactFilename(artifact.title);
		let filePath = join(categoryDir, filename);

		// Avoid overwriting existing artifacts: append a counter suffix
		if (existsSync(filePath)) {
			let counter = 2;
			while (existsSync(join(categoryDir, `${filename.replace(/\.md$/, `-${counter}.md`)}`))) {
				counter++;
			}
			filename = filename.replace(/\.md$/, `-${counter}.md`);
			filePath = join(categoryDir, filename);
		}

		const metadata: Record<string, unknown> = {
			title: artifact.title,
			category: artifact.category,
			timestamp: new Date().toISOString(),
			tags: artifact.tags || [],
		};

		if (this.sessionId) {
			metadata.sessionId = this.sessionId;
		}

		// Merge custom metadata
		if (artifact.metadata) {
			Object.assign(metadata, artifact.metadata);
		}

		const frontmatter = serializeFrontmatter(metadata);
		const content = `${frontmatter}\n\n${artifact.content}`;

		writeFileSync(filePath, content, "utf-8");
		return filePath;
	}

	saveJsonResult(title: string, data: unknown, metadata?: Record<string, unknown>): string {
		this.initialize();
		const categoryDir = join(this.rootDir, "results");
		if (!existsSync(categoryDir)) {
			mkdirSync(categoryDir, { recursive: true });
		}

		let filename = generateJsonFilename(title);
		let filePath = join(categoryDir, filename);
		if (existsSync(filePath)) {
			let counter = 2;
			while (existsSync(join(categoryDir, filename.replace(/\.json$/, `-${counter}.json`)))) {
				counter++;
			}
			filename = filename.replace(/\.json$/, `-${counter}.json`);
			filePath = join(categoryDir, filename);
		}

		writeFileSync(
			filePath,
			`${JSON.stringify(
				{
					metadata: {
						title,
						category: "results",
						timestamp: new Date().toISOString(),
						sessionId: this.sessionId,
						...metadata,
					},
					data,
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
		return filePath;
	}

	/**
	 * Load an artifact by path.
	 */
	load(path: string): ScratchpadEntry | null {
		if (!existsSync(path)) {
			return null;
		}

		const content = readFileSync(path, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);

		return {
			path,
			metadata: {
				title: (frontmatter.title as string) || "",
				category: (frontmatter.category as ScratchpadCategory) || "results",
				timestamp: (frontmatter.timestamp as string) || "",
				sessionId: frontmatter.sessionId as string | undefined,
				tags: frontmatter.tags as string[] | undefined,
				...frontmatter,
			},
			content: body,
		};
	}

	/**
	 * List artifacts in a category, optionally filtered by tags.
	 */
	list(category?: ScratchpadCategory, tags?: string[]): ScratchpadEntry[] {
		this.initialize();

		const entries: ScratchpadEntry[] = [];
		const categories = category ? [category] : ["designs", "plans", "reports", "results", "thoughts", "processes"];

		for (const cat of categories) {
			const dir = join(this.rootDir, cat);
			if (!existsSync(dir)) continue;

			const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
			for (const file of files) {
				const entry = this.load(join(dir, file));
				if (!entry) continue;

				// Filter by tags if specified
				if (tags && tags.length > 0) {
					const entryTags = entry.metadata.tags || [];
					if (!tags.some((tag) => entryTags.includes(tag))) {
						continue;
					}
				}

				entries.push(entry);
			}
		}

		// Sort by timestamp (newest first)
		return entries.sort((a, b) => {
			const aTime = a.metadata.timestamp || "";
			const bTime = b.metadata.timestamp || "";
			return bTime.localeCompare(aTime);
		});
	}

	/**
	 * Search artifacts by title or content.
	 */
	search(query: string, category?: ScratchpadCategory): ScratchpadEntry[] {
		const entries = this.list(category);
		const lowerQuery = query.toLowerCase();

		return entries.filter((entry) => {
			return (
				entry.metadata.title.toLowerCase().includes(lowerQuery) || entry.content.toLowerCase().includes(lowerQuery)
			);
		});
	}

	/**
	 * Get the root scratchpad directory.
	 */
	getRootDir(): string {
		return this.rootDir;
	}
}
