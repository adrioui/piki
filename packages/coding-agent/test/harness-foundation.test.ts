import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { makeCompactionContext, readSubmittedCompactionResult } from "../src/core/compaction/index.ts";
import {
	createToolkit,
	defineHarnessTool,
	expandScratchpadPath,
	harnessToolToAgentTool,
	mergeToolkits,
	validateStreamInput,
} from "../src/core/harness/index.ts";
import { StreamValidationError } from "../src/core/harness/stream-validation.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import { createCheckpointRollbackToolDefinition } from "../src/core/tools/checkpoint-rollback.ts";
import { createTool, createToolDefinition } from "../src/core/tools/index.ts";
import { createRoleControlTool } from "../src/core/tools/role-control-tool.ts";

describe("harness foundation", () => {
	it("adapts a harness tool to the current AgentTool result shape", async () => {
		const harnessTool = defineHarnessTool({
			definition: {
				name: "echo_value",
				description: "Echo a value",
				inputSchema: Schema.Struct({ value: Schema.String }),
				outputSchema: Schema.Struct({ echoed: Schema.String }),
			},
			execute: ({ value }) => Effect.succeed({ echoed: value }),
		});
		const agentTool = harnessToolToAgentTool(harnessTool, {
			parameters: Type.Object({ value: Type.String() }),
			formatOutput: (output) => output.echoed,
		});

		const result = await agentTool.execute("call-1", { value: "ok" }, undefined, undefined);

		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(result.details).toEqual({ echoed: "ok" });
	});

	it("registers and merges tools through Toolkit", () => {
		const first = defineHarnessTool({
			definition: {
				name: "first",
				description: "First",
				inputSchema: Schema.Void,
				outputSchema: Schema.Void,
			},
			execute: () => Effect.void,
		});
		const second = defineHarnessTool({
			definition: {
				name: "second",
				description: "Second",
				inputSchema: Schema.Void,
				outputSchema: Schema.Void,
			},
			execute: () => Effect.void,
		});

		const merged = createToolkit([first]).merge(createToolkit([second]));

		expect(merged.get("first")).toBe(first);
		expect(merged.get("second")).toBe(second);
		expect(merged.list().map((tool) => tool.definition.name)).toEqual(["first", "second"]);
		expect(
			merged
				.pick(["second"])
				.list()
				.map((tool) => tool.definition.name),
		).toEqual(["second"]);
		expect(
			merged
				.omit(["first"])
				.list()
				.map((tool) => tool.definition.name),
		).toEqual(["second"]);
		expect(
			mergeToolkits(createToolkit([first]), createToolkit([second]))
				.list()
				.map((tool) => tool.definition.name),
		).toEqual(["first", "second"]);
	});

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

			expect(readTool.description).toContain("Read file text content");
			expect(firstBlock?.type).toBe("text");
			if (firstBlock?.type !== "text") {
				throw new Error("read tool should return text");
			}
			expect(firstBlock.text).toContain("alpha");

			const readDefinition = createToolDefinition("read", tempDir, { scratchpadPath: tempDir });
			expect(readDefinition.description).toContain("Read file text content");
			expect(readDefinition.renderCall).toBeTypeOf("function");

			const editDefinition = createToolDefinition("edit", tempDir, { scratchpadPath: tempDir });
			expect(editDefinition.stream).toBeDefined();
			expect(editDefinition.emissionSchema).toBeDefined();
			expect(editDefinition.errorSchema).toBeDefined();
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
		const result = await compact.execute("call-1", { custom_instructions: "focus" });

		expect(compact.name).toBe("compact");
		expect(props.custom_instructions).toBeDefined();
		expect(result.content[0]).toEqual({ type: "text", text: "Compacted context.\n\nsummary:focus" });
		expect(result.details).toEqual({
			summary: "summary:focus",
			firstKeptEntryId: "entry-1",
			tokensBefore: 123,
			estimatedTokensAfter: 45,
		});
	});

	it("supports lifecycle-guarded compact submissions", async () => {
		const context = await Effect.runPromise(makeCompactionContext({ maxPayloadTokens: 1000 }));
		const compact = createTool("compact", "/tmp", {
			compact: {
				getCompactionContext: () => context,
			},
		});
		const result = await compact.execute("call-1", {
			summary: "Keep the implementation plan.",
			reflection: "Continue from the VCS tests.",
			files: ["packages/coding-agent/src/core/vcs/shadow-vcs.ts"],
		});
		const submitted = await Effect.runPromise(readSubmittedCompactionResult(context));

		expect(result.details).toMatchObject({
			status: "ok",
			filesRead: 1,
			summary: "Keep the implementation plan.",
			reflection: "Continue from the VCS tests.",
		});
		expect(submitted?.summary).toBe("Keep the implementation plan.");
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
		expect(searchProps.numResults).toBeDefined();
		expect(webFetch.name).toBe("web_fetch");
		expect(fetchProps.url).toBeDefined();
		expect(fetchProps.max_length).toBeDefined();
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
			const result = await skill.execute("call-1", { name: "debugger", args: "Investigate failure" });

			expect(skill.name).toBe("skill");
			expect(props.name).toBeDefined();
			expect(props.args).toBeDefined();
			expect(result.content[0]?.type).toBe("text");
			expect(result.content[0]).toEqual({
				type: "text",
				text: `<skill name="debugger" location="${join(skillDir, "SKILL.md")}">\nReferences are relative to ${skillDir}.\n\nUse logs and tests.\n</skill>\n\nInvestigate failure`,
			});
			expect(result.details).toEqual({
				skillName: "debugger",
				skillPath: join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				hasArgs: true,
			});
			expect(activations).toEqual([result.details]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
