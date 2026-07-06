// packages/coding-agent/test/util/gitignore-walker.test.ts
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walk } from "../../src/core/util/gitignore-walker.ts";

/** Helper: create a temp directory, call fn with its path, then clean up. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "g24-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Write a file, creating parent directories recursively. */
async function writeFileAt(base: string, filePath: string, content: string): Promise<void> {
	const fullPath = join(base, filePath);
	await mkdir(join(fullPath, ".."), { recursive: true });
	await writeFile(fullPath, content, "utf8");
}

describe("gitignore-walker", () => {
	afterEach(() => {
		// cleanup is handled by withTempDir
	});

	it("basic walk — returns all entries except ALWAYS_EXCLUDED, parent-then-children", async () => {
		await withTempDir(async (dir) => {
			// Create: a/b/c.txt, d/e.txt
			await writeFileAt(dir, "a/b/c.txt", "hello");
			await writeFileAt(dir, "d/e.txt", "world");

			const entries = await walk(dir);

			// Should have exactly 5 entries: a, a/b, a/b/c.txt, d, d/e.txt
			expect(entries.length).toBe(5);

			// Check all paths are present
			const relPaths = entries.map((e) => e.relativePath);
			expect(relPaths).toContain("a");
			expect(relPaths).toContain("a/b");
			expect(relPaths).toContain("a/b/c.txt");
			expect(relPaths).toContain("d");
			expect(relPaths).toContain("d/e.txt");

			// Check order: parent before child within each directory
			const aIdx = relPaths.indexOf("a");
			const abIdx = relPaths.indexOf("a/b");
			const abcIdx = relPaths.indexOf("a/b/c.txt");
			expect(aIdx).toBeLessThan(abIdx);
			expect(abIdx).toBeLessThan(abcIdx);

			// No entry should start with ".git" or ".vcs"
			for (const rp of relPaths) {
				expect(rp.startsWith(".git")).toBe(false);
				expect(rp.startsWith(".vcs")).toBe(false);
			}

			// Check entry shape
			const fileEntry = entries.find((e) => e.relativePath === "a/b/c.txt")!;
			expect(fileEntry.fullPath).toBe(join(dir, "a/b/c.txt"));
			expect(fileEntry.name).toBe("c.txt");
			expect(fileEntry.type).toBe("file");
			expect(fileEntry.depth).toBe(2);
			expect(fileEntry.size).toBeUndefined();
			expect(fileEntry.mtimeMs).toBeUndefined();
		});
	});

	it("nested gitignore — root ignores *.log, sub/.gitignore ignores *.tmp", async () => {
		await withTempDir(async (dir) => {
			// Root: x.log, keep.txt
			// sub/: y.tmp, z.txt, sub/.gitignore ignoring *.tmp
			await writeFileAt(dir, "x.log", "should be ignored");
			await writeFileAt(dir, "keep.txt", "keep me");
			await writeFileAt(dir, ".gitignore", "*.log\n");
			await writeFileAt(dir, "sub/y.tmp", "should be ignored");
			await writeFileAt(dir, "sub/z.txt", "keep me");
			await writeFileAt(dir, "sub/.gitignore", "*.tmp\n");

			const entries = await walk(dir);
			const relPaths = entries.map((e) => e.relativePath);

			// x.log should be excluded by root .gitignore
			expect(relPaths).not.toContain("x.log");
			// keep.txt should be present
			expect(relPaths).toContain("keep.txt");
			// sub/y.tmp should be excluded by sub/.gitignore
			expect(relPaths).not.toContain("sub/y.tmp");
			// sub/z.txt should be present
			expect(relPaths).toContain("sub/z.txt");
			// sub directory itself should be present
			expect(relPaths).toContain("sub");
		});
	});

	it("negation pattern — !keep.log overrides *.log", async () => {
		await withTempDir(async (dir) => {
			await writeFileAt(dir, ".gitignore", "*.log\n!keep.log\n");
			await writeFileAt(dir, "keep.log", "should be kept");
			await writeFileAt(dir, "other.log", "should be ignored");

			const entries = await walk(dir);
			const relPaths = entries.map((e) => e.relativePath);

			expect(relPaths).toContain("keep.log");
			expect(relPaths).not.toContain("other.log");
		});
	});

	it("ALWAYS_EXCLUDED skips .git even when present", async () => {
		await withTempDir(async (dir) => {
			await writeFileAt(dir, ".git/HEAD", "ref: refs/heads/main\n");
			await writeFileAt(dir, "readme.md", "hello");

			const entries = await walk(dir);
			const relPaths = entries.map((e) => e.relativePath);

			// .git should not appear at all
			expect(relPaths).not.toContain(".git");
			expect(relPaths).not.toContain(".git/HEAD");
			// readme.md should be present
			expect(relPaths).toContain("readme.md");
		});
	});

	it("symlink skip — default opts skips symlinks; followSymlinks:true does not throw", async () => {
		await withTempDir(async (dir) => {
			// Create a real directory (name not in DEFAULT_IGNORE_PATTERNS) with a file
			await writeFileAt(dir, "data/content.txt", "real file");
			// Create a symlink to that directory
			await symlink(join(dir, "data"), join(dir, "link-data"), "dir");

			// Default: symlink should be absent
			const entriesDefault = await walk(dir);
			expect(entriesDefault.some((e) => e.name === "link-data")).toBe(false);
			// real dir should still be walked
			expect(entriesDefault.some((e) => e.relativePath === "data/content.txt")).toBe(true);

			// followSymlinks: true should not throw
			const entriesFollow = await walk(dir, { followSymlinks: true });
			// At minimum the real dir content should be present
			expect(entriesFollow.some((e) => e.relativePath === "data/content.txt")).toBe(true);
			// The symlink entry itself should appear in follow mode
			const linkEntry = entriesFollow.find((e) => e.name === "link-data");
			expect(linkEntry).toBeDefined();
		});
	});
});
