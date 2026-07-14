/**
 * Folder tree node and flat directory entry types.
 */

/** A node in the folder tree. */
export interface FolderTreeNode {
	name: string;
	children: FolderTreeNode[];
	lastModified: number;
	totalBytes: number;
}

/** A flat directory entry (input to buildTree). */
export interface DirEntry {
	type: "dir" | "file";
	name: string;
	relativePath: string;
	size?: number;
}

/**
 * Build a tree from flat directory entries.
 * Creates nodes for dirs, links parents via path splitting, and
 * accumulates file sizes upward via a recursive `propagate` pass.
 */
export function buildTree(entries: DirEntry[]): FolderTreeNode[] {
	const nodeMap = new Map<string, FolderTreeNode>();
	const roots: FolderTreeNode[] = [];

	// Create nodes for all directories
	const dirs = entries.filter((e) => e.type === "dir");
	for (const entry of dirs) {
		nodeMap.set(entry.relativePath, {
			name: entry.name,
			children: [],
			lastModified: 0,
			totalBytes: 0,
		});
	}

	// Link parent → child via path splitting
	for (const entry of dirs) {
		const node = nodeMap.get(entry.relativePath)!;
		const parts = entry.relativePath.split("/");
		if (parts.length === 1) {
			roots.push(node);
		} else {
			const parentPath = parts.slice(0, -1).join("/");
			const parent = nodeMap.get(parentPath);
			if (parent) {
				parent.children.push(node);
			}
		}
	}

	// Accumulate file sizes into parent directories
	const files = entries.filter((e) => e.type === "file" && e.size !== undefined);
	for (const file of files) {
		const parts = file.relativePath.split("/");
		if (parts.length < 2) continue;
		const parentPath = parts.slice(0, -1).join("/");
		const parent = nodeMap.get(parentPath);
		if (parent) {
			parent.totalBytes += file.size!;
		}
	}

	// Propagate file sizes upward through the tree
	function propagate(node: FolderTreeNode): number {
		for (const child of node.children) {
			node.totalBytes += propagate(child);
		}
		return node.totalBytes;
	}

	for (const root of roots) {
		propagate(root);
	}

	return roots;
}
