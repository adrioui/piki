/**
 * Tests for worker-tools role-based toolkit filtering.
 */

import type { TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import type { WorkerTool } from "../src/core/worker-session.ts";
import { filterToolsForRole } from "../src/core/worker-tools.ts";

const dummySchema = {} as TSchema;

function tool(name: string, overrides?: Partial<WorkerTool>): WorkerTool {
	return {
		name,
		description: name,
		parameters: dummySchema,
		execute: async () => ({ content: [], details: undefined }),
		...overrides,
	};
}

// All tools available in the system (superset).
const ALL_TOOLS: WorkerTool[] = [
	// workerBase
	tool("read"),
	tool("bash"),
	tool("edit"),
	tool("write"),
	tool("grep"),
	tool("find"),
	tool("ls"),
	tool("web_search"),
	tool("web_fetch"),
	tool("skill"),
	tool("compact"),
	tool("scratchpad_save"),
	tool("scratchpad_load"),
	// criticBase subset (already in workerBase except bash/read/grep/find/ls)
	// leader-only
	tool("spawnWorker"),
	tool("killWorker"),
	tool("messageWorker"),
	tool("reassignWorker"),
	tool("createTask"),
	tool("updateTask"),
	tool("messageAdvisor"),
	tool("finishGoal"),
	tool("pass"),
	tool("escalate"),
	tool("checkpoint_changes"),
	tool("restore_snapshot"),
];

const names = (tools: WorkerTool[]) => tools.map((t) => t.name).sort();

describe("filterToolsForRole", () => {
	describe("observer role (observerToolkit)", () => {
		it("returns only pass and escalate", () => {
			const result = filterToolsForRole("observer", ALL_TOOLS);
			expect(names(result)).toEqual(["escalate", "pass"]);
		});

		it("does not include filesystem tools", () => {
			const result = filterToolsForRole("observer", ALL_TOOLS);
			const resultNames = names(result);
			expect(resultNames).not.toContain("read");
			expect(resultNames).not.toContain("bash");
			expect(resultNames).not.toContain("edit");
			expect(resultNames).not.toContain("write");
		});

		it("does not include worker-management tools", () => {
			const result = filterToolsForRole("observer", ALL_TOOLS);
			const resultNames = names(result);
			expect(resultNames).not.toContain("spawnWorker");
			expect(resultNames).not.toContain("killWorker");
			expect(resultNames).not.toContain("messageWorker");
		});

		it("does not include web tools", () => {
			const result = filterToolsForRole("observer", ALL_TOOLS);
			const resultNames = names(result);
			expect(resultNames).not.toContain("web_search");
			expect(resultNames).not.toContain("web_fetch");
		});
	});

	describe("critic role (criticBase)", () => {
		it("returns read-only tools", () => {
			const result = filterToolsForRole("critic", ALL_TOOLS);
			expect(names(result)).toEqual(["bash", "find", "grep", "ls", "read"]);
		});

		it("does not include write/edit", () => {
			const result = filterToolsForRole("critic", ALL_TOOLS);
			const resultNames = names(result);
			expect(resultNames).not.toContain("edit");
			expect(resultNames).not.toContain("write");
		});

		it("does not include leader-only tools", () => {
			const result = filterToolsForRole("critic", ALL_TOOLS);
			const resultNames = names(result);
			expect(resultNames).not.toContain("pass");
			expect(resultNames).not.toContain("escalate");
			expect(resultNames).not.toContain("spawnWorker");
		});
	});

	describe("engineer role (workerBase, no web)", () => {
		it("returns workerBase tools minus web tools", () => {
			const result = filterToolsForRole("engineer", ALL_TOOLS);
			expect(names(result)).toEqual([
				"bash",
				"compact",
				"edit",
				"find",
				"grep",
				"ls",
				"read",
				"scratchpad_load",
				"scratchpad_save",
				"skill",
				"write",
			]);
		});

		it("does not include leader-only tools", () => {
			const result = filterToolsForRole("engineer", ALL_TOOLS);
			const resultNames = names(result);
			expect(resultNames).not.toContain("pass");
			expect(resultNames).not.toContain("escalate");
			expect(resultNames).not.toContain("spawnWorker");
			expect(resultNames).not.toContain("finishGoal");
		});
	});

	describe("scout role (workerBase, web enabled)", () => {
		it("includes web tools", () => {
			const result = filterToolsForRole("scout", ALL_TOOLS);
			const resultNames = names(result);
			expect(resultNames).toContain("web_search");
			expect(resultNames).toContain("web_fetch");
		});

		it("does not include leader-only tools", () => {
			const result = filterToolsForRole("scout", ALL_TOOLS);
			const resultNames = names(result);
			expect(resultNames).not.toContain("pass");
			expect(resultNames).not.toContain("escalate");
			expect(resultNames).not.toContain("spawnWorker");
		});
	});

	describe("compact role (compactToolkit)", () => {
		it("returns no tools", () => {
			const result = filterToolsForRole("compact", ALL_TOOLS);
			expect(result).toEqual([]);
		});
	});

	describe("hidden and internal tools", () => {
		it("excludes hidden tools by default", () => {
			const tools = [tool("read"), tool("bash", { hidden: true })];
			const result = filterToolsForRole("engineer", tools);
			expect(names(result)).toEqual(["read"]);
		});

		it("includes hidden tools when includeHidden is true", () => {
			const tools = [tool("read"), tool("bash", { hidden: true })];
			const result = filterToolsForRole("engineer", tools, { includeHidden: true });
			expect(names(result)).toEqual(["bash", "read"]);
		});

		it("excludes internal tools by default", () => {
			const tools = [tool("read"), tool("bash", { internal: true })];
			const result = filterToolsForRole("engineer", tools);
			expect(names(result)).toEqual(["read"]);
		});

		it("includes internal tools when includeInternal is true", () => {
			const tools = [tool("read"), tool("bash", { internal: true })];
			const result = filterToolsForRole("engineer", tools, { includeInternal: true });
			expect(names(result)).toEqual(["bash", "read"]);
		});
	});
});
