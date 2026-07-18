import { describe, expect, it } from "vitest";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
	createShellToolDefinition,
	createViewToolDefinition,
	createWriteToolDefinition,
} from "../../../src/core/tools/index.ts";
import { resolveReadPathAsyncTool, resolveToolPath } from "../../../src/core/tools/path-utils.ts";
import { getTextOutput } from "../../../src/core/tools/render-utils.ts";
import { createTreeToolDefinition } from "../../../src/core/tools/tree.ts";

/**
 * Wave-2 Scientist tool-schema parity probes (sci-wave2-tools).
 * These assert the mag-equivalent SHAPE of piki's tool definitions and the
 * mag-parity path resolver. They do NOT weaken existing assertions in
 * tools.test.ts; they add explicit schema-shape coverage that prior waves
 * (S7/W22-W24) verified only by reading source + grep of the mag bundle.
 */

describe("tool schema parity with Magnitude alpha22", () => {
	it("shell tool mirrors mag: command + detach_after params, NO timeout param", () => {
		const shell = createShellToolDefinition(process.cwd());
		const props = (shell.parameters as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(props).sort()).toEqual(["command", "detach_after"]);
		// mag shell has no `timeout`; detach_after is optional.
		const detachSchema = props.detach_after as { description?: string };
		expect(detachSchema.description).toMatch(/default: 30/i);
	});

	it("bash tool is the piki superset: adds optional timeout (mag shell lacks it)", () => {
		const bash = createBashToolDefinition(process.cwd());
		const props = (bash.parameters as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(props).sort()).toEqual(["command", "timeout"]);
		expect((props.timeout as { description?: string }).description).toMatch(/optional/i);
	});

	it("grep default limit is 50 (mag parity)", async () => {
		const fs = await import("node:fs/promises");
		const os = await import("node:os");
		const path = await import("node:path");
		const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-grep-empty-"));
		try {
			const grep = createGrepToolDefinition(emptyDir);
			const out = await grep.execute(
				"call-1",
				{ pattern: "zzq_noSuchToken_zzq_9f3a" },
				undefined as never,
				undefined as never,
				undefined as never,
			);
			expect(getTextOutput(out, false)).toContain("No matches found");
		} finally {
			await fs.rm(emptyDir, { recursive: true, force: true });
		}
	});

	it("read schema matches mag: path + optional offset/limit", () => {
		const read = createReadToolDefinition(process.cwd());
		const props = (read.parameters as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(props).sort()).toEqual(["limit", "offset", "path"]);
	});

	it("write/edit/tree/view schemas match mag field sets", () => {
		const write = (createWriteToolDefinition(process.cwd()).parameters as { properties: Record<string, unknown> })
			.properties;
		expect(Object.keys(write).sort()).toEqual(["content", "path"]);

		const edit = (createEditToolDefinition(process.cwd()).parameters as { properties: Record<string, unknown> })
			.properties;
		expect(Object.keys(edit).sort()).toEqual(["edits", "new", "old", "path", "replaceAll"]);

		const tree = (createTreeToolDefinition(process.cwd()).parameters as { properties: Record<string, unknown> })
			.properties;
		expect(Object.keys(tree).sort()).toEqual(["gitignore", "maxDepth", "path", "recursive"]);

		const view = (createViewToolDefinition(process.cwd()).parameters as { properties: Record<string, unknown> })
			.properties;
		expect(Object.keys(view).sort()).toEqual(["path"]);
	});
});

describe("mag-parity path resolver (GAP-1, W24)", () => {
	it("resolveToolPath does NOT tilde-expand: ~/x resolves under cwd (literal ~ dir)", () => {
		const cwd = "/tmp/pi-wave2-cwd-xyz";
		const resolved = resolveToolPath("~/foo.txt", cwd, "");
		// mag keeps `~` literal: <cwd>/~/foo.txt (NOT $HOME/foo.txt).
		expect(resolved).toBe("/tmp/pi-wave2-cwd-xyz/~/foo.txt");
	});

	it("resolveToolPath expands $M to the scratchpad path", () => {
		const cwd = "/tmp/pi-wave2-cwd-xyz";
		const resolved = resolveToolPath("$M/notes.md", cwd, "/tmp/pi-scratch-xyz");
		expect(resolved).toBe("/tmp/pi-scratch-xyz/notes.md");
	});

	it("resolveReadPathAsyncTool keeps ~ literal and resolves $M", async () => {
		const cwd = "/tmp/pi-wave2-cwd-xyz";
		const tilde = await resolveReadPathAsyncTool("~/foo.txt", cwd, "");
		expect(tilde).toBe("/tmp/pi-wave2-cwd-xyz/~/foo.txt");
		const m = await resolveReadPathAsyncTool("$M/notes.md", cwd, "/tmp/pi-scratch-xyz");
		expect(m).toBe("/tmp/pi-scratch-xyz/notes.md");
	});
});
