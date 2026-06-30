/**
 * Local Taste Registry - Phase 9.
 *
 * A local JSON-based registry for taste profiles with namespace/ownership
 * and public/private visibility. The interface is designed to allow future
 * remote backends but no remote server is currently available.
 *
 * Supports push (publish a taste package to the registry) and pull
 * (download a taste package from the registry into a workspace).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTasteDir } from "../config.ts";

export type Visibility = "public" | "private";

export interface TastePackage {
	/** Unique package ID (namespace/name hash). */
	id: string;
	/** Namespace (owner handle, e.g. "myteam" or "user"). */
	namespace: string;
	/** Package name (e.g. "python-style" or "react-conventions"). */
	name: string;
	/** Visibility: public (discoverable) or private (owner only). */
	visibility: Visibility;
	/** Taste profile content (markdown). */
	content: string;
	/** Content hash for integrity checking. */
	hash: string;
	/** Version string. */
	version: string;
	/** Creation timestamp. */
	createdAt: string;
	/** Last updated timestamp. */
	updatedAt: string;
	/** Optional description. */
	description?: string;
	/** Optional tags for discovery. */
	tags?: string[];
}

export interface TasteRegistryEntry {
	package: TastePackage;
	path: string;
}

export interface PushResult {
	id: string;
	namespace: string;
	name: string;
	version: string;
	hash: string;
	created: boolean;
}

export interface PullResult {
	destination: string;
	hash: string;
	version: string;
	overwrite: boolean;
}

export interface ListOptions {
	namespace?: string;
	visibility?: Visibility;
	tag?: string;
}

function computeHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function packageId(namespace: string, name: string): string {
	return createHash("sha1").update(`${namespace}/${name}`).digest("hex").slice(0, 12);
}

function packageDir(baseDir: string, namespace: string, name: string): string {
	return join(baseDir, "registry", namespace, name);
}

function packagePath(baseDir: string, namespace: string, name: string): string {
	return join(packageDir(baseDir, namespace, name), "package.json");
}

/**
 * Local JSON-based taste registry.
 *
 * The registry stores taste packages as JSON files in a directory structure:
 *   <baseDir>/registry/<namespace>/<name>/package.json
 *
 * The API shape (push, pull, list, delete) is designed so a remote
 * backend can be added later without modifying calling code.
 */
export class TasteRegistry {
	private readonly baseDir: string;

	constructor(baseDir = getTasteDir()) {
		this.baseDir = baseDir;
	}

	/**
	 * Push a taste profile to the registry.
	 * Creates a new package or updates an existing one.
	 */
	push(options: {
		namespace: string;
		name: string;
		content: string;
		visibility?: Visibility;
		description?: string;
		tags?: string[];
	}): PushResult {
		const { namespace, name, content } = options;
		const id = packageId(namespace, name);
		const dir = packageDir(this.baseDir, namespace, name);
		const path = packagePath(this.baseDir, namespace, name);
		const hash = computeHash(content);
		const now = new Date().toISOString();

		const existing = this.readPackage(namespace, name);
		const version = existing ? `${Number.parseInt(existing.version, 10) + 1}` : "1";

		const pkg: TastePackage = {
			id,
			namespace,
			name,
			visibility: options.visibility ?? "private",
			content,
			hash,
			version,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			description: options.description,
			tags: options.tags,
		};

		mkdirSync(dir, { recursive: true });
		writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);

		return {
			id,
			namespace,
			name,
			version,
			hash,
			created: !existing,
		};
	}

	/**
	 * Pull a taste package from the registry into a destination workspace.
	 */
	pull(namespace: string, name: string, destinationDir: string): PullResult {
		const pkg = this.readPackage(namespace, name);
		if (!pkg) {
			throw new Error(`Package not found: ${namespace}/${name}`);
		}

		mkdirSync(destinationDir, { recursive: true });
		const destPath = join(destinationDir, "taste.md");
		const overwrite = existsSync(destPath);
		writeFileSync(destPath, pkg.content);

		return {
			destination: destPath,
			hash: pkg.hash,
			version: pkg.version,
			overwrite,
		};
	}

	/**
	 * List packages in the registry, optionally filtered.
	 */
	list(options: ListOptions = {}): TasteRegistryEntry[] {
		const registryDir = join(this.baseDir, "registry");
		if (!existsSync(registryDir)) return [];

		const entries: TasteRegistryEntry[] = [];
		const namespaces = options.namespace
			? [options.namespace]
			: readdirSync(registryDir, { withFileTypes: true })
					.filter((e) => e.isDirectory())
					.map((e) => e.name);

		for (const ns of namespaces) {
			const nsDir = join(registryDir, ns);
			if (!existsSync(nsDir)) continue;
			for (const nameDir of readdirSync(nsDir, { withFileTypes: true })) {
				if (!nameDir.isDirectory()) continue;
				const path = join(nsDir, nameDir.name, "package.json");
				if (!existsSync(path)) continue;
				try {
					const pkg = JSON.parse(readFileSync(path, "utf-8")) as TastePackage;
					if (options.visibility && pkg.visibility !== options.visibility) continue;
					if (options.tag && !(pkg.tags ?? []).includes(options.tag)) continue;
					entries.push({ package: pkg, path });
				} catch {
					// Skip corrupt entries
				}
			}
		}

		return entries;
	}

	/**
	 * Get a specific package by namespace/name.
	 */
	get(namespace: string, name: string): TastePackage | undefined {
		return this.readPackage(namespace, name);
	}

	/**
	 * Delete a package from the registry.
	 */
	delete(namespace: string, name: string): boolean {
		const dir = packageDir(this.baseDir, namespace, name);
		if (!existsSync(dir)) return false;
		rmSync(dir, { recursive: true, force: true });
		return true;
	}

	/**
	 * Search packages by keyword in name, description, or tags.
	 */
	search(query: string): TasteRegistryEntry[] {
		const lower = query.toLowerCase();
		return this.list().filter((entry) => {
			const pkg = entry.package;
			return (
				pkg.name.toLowerCase().includes(lower) ||
				(pkg.description?.toLowerCase().includes(lower) ?? false) ||
				(pkg.tags?.some((tag) => tag.toLowerCase().includes(lower)) ?? false) ||
				pkg.namespace.toLowerCase().includes(lower)
			);
		});
	}

	private readPackage(namespace: string, name: string): TastePackage | undefined {
		const path = packagePath(this.baseDir, namespace, name);
		if (!existsSync(path)) return undefined;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as TastePackage;
		} catch {
			return undefined;
		}
	}
}

/**
 * Parse a "namespace/name" slug into its components.
 */
export function parsePackageSlug(slug: string): {
	namespace: string;
	name: string;
} {
	const parts = slug.split("/");
	const namespace = parts[0];
	const name = parts[1];
	if (parts.length !== 2 || !namespace || !name) {
		throw new Error(`Invalid package slug: "${slug}". Expected format: namespace/name`);
	}
	const safeSegment = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
	if (
		!safeSegment.test(namespace) ||
		!safeSegment.test(name) ||
		namespace === "." ||
		namespace === ".." ||
		name === "." ||
		name === ".."
	) {
		throw new Error(`Invalid package slug: "${slug}". Namespace and name must be safe path segments`);
	}
	return { namespace, name };
}

/**
 * Create a package slug from namespace and name.
 */
export function packageSlug(namespace: string, name: string): string {
	return `${namespace}/${name}`;
}
