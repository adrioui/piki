import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDir } from "@piki/skills";
import { describe, expect, it } from "vitest";
import { expandScratchpadPath, validateStreamInput } from "../src/core/harness/index.ts";
import { StreamValidationError } from "../src/core/harness/stream-validation.ts";
import { createCheckpointRollbackToolDefinition } from "../src/core/tools/checkpoint-rollback.ts";
import { createTool, createToolDefinition } from "../src/core/tools/index.ts";
import { createRoleControlTool } from "../src/core/tools/role-control-tool.ts";

describe("harness foundation", () => {
	it("expands $M scratchpad paths", () => {
		expect(expandScratchpadPath("$M", "/tmp/session/scratchpad")).toEqual({
			path: "/tmp/session/scratchpad",
			expanded: true,
			displayPath: "",
		});
		expect(expandScratchpadPath("$M/reports/a.md", "/tmp/session/scratchpad").path).toBe(
			"/tmp/session/scratchpad/reports/a.md",
		);
		expect(expandScratchpadPath("README.md", "/tmp/session/scratchpad")).toEqual({
			path: "README.md",
			expanded: false,
			displayPath: "README.md",
		});
	});

	it("wraps stream validation errors", () => {
		expect(() =>
			validateStreamInput<{ value: string }>(
				{
					onInput: () => {
						throw new Error("bad partial input");
					},
				},
				{ value: "x" },
			),
		).toThrow(StreamValidationError);
	});

	it("wires migrated filesystem tools through the public tool registry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "piki-harness-registry-"));
		try {
			writeFileSync(join(tempDir, "sample.txt"), "alpha\nbeta", "utf-8");

			const readTool = createTool("read", tempDir, { scratchpadPath: tempDir });
			const result = await readTool.execute("call-1", { path: "sample.txt" });
			const firstBlock = result.content[0];

			expect(readTool.description).toContain("Read the contents of a file");
			expect(firstBlock?.type).toBe("text");
			if (firstBlock?.type !== "text") {
				throw new Error("read tool should return text");
			}
			expect(firstBlock.text).toContain("alpha");

			const readDefinition = createToolDefinition("read", tempDir, { scratchpadPath: tempDir });
			expect(readDefinition.description).toContain("Read the contents of a file");
			expect(readDefinition.renderCall).toBeTypeOf("function");

			const editDefinition = createToolDefinition("edit", tempDir, { scratchpadPath: tempDir });
			expect(editDefinition.stream).toBeDefined();
			expect(editDefinition.renderCall).toBeTypeOf("function");
			// The edit tool definition intentionally leaves emissionSchema and
			// errorSchema undefined (stream-based tool); assert the contract.
			expect(editDefinition.emissionSchema).toBeUndefined();
			expect(editDefinition.errorSchema).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exposes compatible shell and role-control aliases", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "piki-harness-alias-"));
		try {
			const shellTool = createTool("shell", tempDir, { scratchpadPath: tempDir });
			const shellResult = await shellTool.execute("call-1", { command: "printf ok" });
			const shellBlock = shellResult.content[0];

			expect(shellTool.name).toBe("shell");
			const shellProps = (
				shellTool.parameters as typeof shellTool.parameters & { properties: Record<string, unknown> }
			).properties;
			expect(shellProps.detach_after).toBeDefined();
			expect(shellBlock?.type).toBe("text");
			if (shellBlock?.type !== "text") {
				throw new Error("shell tool should return text");
			}
			expect(shellBlock.text).toContain("ok");

			const roleTool = createRoleControlTool("spawn_worker", "");
			expect(roleTool.name).toBe("spawn_worker");
			const roleProps = (roleTool.parameters as typeof roleTool.parameters & { properties: Record<string, unknown> })
				.properties;
			expect(roleProps.agentId).toBeDefined();
			expect(roleProps.yield).toBeDefined();

			const passTool = createRoleControlTool("pass", "");
			const escalateTool = createRoleControlTool("escalate", "");
			const escalateProps = (
				escalateTool.parameters as typeof escalateTool.parameters & { properties: Record<string, unknown> }
			).properties;
			expect(passTool.name).toBe("pass");
			expect(escalateTool.name).toBe("escalate");
			expect(escalateProps.justification).toBeDefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exposes compatible checkpoint rollback schema", () => {
		const rollback = createCheckpointRollbackToolDefinition("/tmp", "session-1");
		const props = (rollback.parameters as typeof rollback.parameters & { properties: Record<string, unknown> })
			.properties;

		expect(rollback.name).toBe("checkpoint_rollback");
		expect(props.since).toBeDefined();
		expect(props.glob).toBeDefined();
	});

	it("exposes compatible compact tool", async () => {
		const compact = createTool("compact", "/tmp", {
			compact: {
				runCompact: async (customInstructions) => ({
					summary: `summary:${customInstructions ?? ""}`,
					firstKeptEntryId: "entry-1",
					tokensBefore: 123,
					estimatedTokensAfter: 45,
				}),
			},
		});

		const props = (compact.parameters as typeof compact.parameters & { properties: Record<string, unknown> })
			.properties;
		const result = await compact.execute("call-1", {});

		expect(compact.name).toBe("compact");
		expect(props.summary).toBeDefined();
		expect(result.content[0]).toEqual({ type: "text", text: "Compacted context.\n\nsummary:" });
		expect(result.details).toEqual({
			summary: "summary:",
			firstKeptEntryId: "entry-1",
			tokensBefore: 123,
			estimatedTokensAfter: 45,
		});
	});

	it("runs live session compaction via runCompact", async () => {
		let captured: string | undefined;
		const compact = createTool("compact", "/tmp", {
			compact: {
				runCompact: async (customInstructions) => {
					captured = customInstructions;
					return {
						summary: "Keep the implementation plan.",
						firstKeptEntryId: "entry-1",
						tokensBefore: 123,
						estimatedTokensAfter: 45,
					};
				},
			},
		});
		const result = await compact.execute("call-1", {
			summary: "Keep the implementation plan.",
			reflection: "Continue from the VCS tests.",
			files: ["packages/coding-agent/src/core/vcs/shadow-vcs.ts"],
		});

		expect(captured).toBeUndefined();
		expect(result.details).toMatchObject({
			summary: "Keep the implementation plan.",
			firstKeptEntryId: "entry-1",
			tokensBefore: 123,
			estimatedTokensAfter: 45,
		});
	});

	it("exposes compatible query_image tool", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "piki-query-image-"));
		try {
			const image = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				"base64",
			);
			writeFileSync(join(tempDir, "pixel.png"), image);
			const queryImage = createTool("query_image", tempDir, {
				queryImage: {
					queryVisionModel: async (_imageBase64, mimeType, query) => `${mimeType}:${query}`,
				},
			});
			const props = (queryImage.parameters as typeof queryImage.parameters & { properties: Record<string, unknown> })
				.properties;
			const result = await queryImage.execute("call-1", { path: "pixel.png", query: "what is this?" });

			expect(queryImage.name).toBe("query_image");
			expect(props.path).toBeDefined();
			expect(props.query).toBeDefined();
			expect(result.content[0]).toEqual({ type: "text", text: "image/png:what is this?" });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exposes web tools through the public tool registry", () => {
		const webSearch = createToolDefinition("web_search", "/tmp");
		const webFetch = createToolDefinition("web_fetch", "/tmp");
		const searchProps = (
			webSearch.parameters as typeof webSearch.parameters & { properties: Record<string, unknown> }
		).properties;
		const fetchProps = (webFetch.parameters as typeof webFetch.parameters & { properties: Record<string, unknown> })
			.properties;

		expect(webSearch.name).toBe("web_search");
		expect(searchProps.query).toBeDefined();
		expect(searchProps.maxResults).toBeDefined();
		expect(webFetch.name).toBe("web_fetch");
		expect(fetchProps.url).toBeDefined();
		expect(fetchProps.maxLength).toBeDefined();
	});

	it("exposes compatible skill tool", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "piki-skill-tool-"));
		try {
			const skillDir = join(tempDir, "debugger");
			mkdirSync(skillDir);
			writeFileSync(
				join(skillDir, "SKILL.md"),
				"---\nname: debugger\ndescription: Debug problems\n---\nUse logs and tests.",
				"utf8",
			);
			const skills = loadSkillsFromDir({ dir: tempDir, source: "project" }).skills;
			const activations: unknown[] = [];
			const skill = createTool("skill", tempDir, {
				skill: {
					getSkills: () => skills,
					onSkillActivated: (details) => activations.push(details),
				},
			});

			const props = (skill.parameters as typeof skill.parameters & { properties: Record<string, unknown> })
				.properties;
			const result = await skill.execute("call-1", { name: "debugger" });

			expect(skill.name).toBe("skill");
			expect(props.name).toBeDefined();
			expect(result.content[0]?.type).toBe("text");
			expect(result.content[0]).toEqual({
				type: "text",
				text: `<skill name="debugger" location="${join(skillDir, "SKILL.md")}">\nReferences are relative to ${skillDir}.\n\nUse logs and tests.\n</skill>`,
			});
			expect(result.details).toEqual({
				skillName: "debugger",
				skillPath: join(skillDir, "SKILL.md"),
				baseDir: skillDir,
			});
			expect(activations).toEqual([result.details]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
