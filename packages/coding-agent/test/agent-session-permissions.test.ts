import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@piki/ai/compat";
import { getModel } from "@piki/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function createAssistantWithToolCall(
	name: string,
	args: Record<string, unknown>,
): {
	assistantMessage: AssistantMessage;
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
} {
	const toolCall = { type: "toolCall" as const, id: "toolu_test", name, arguments: args };
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
	return { assistantMessage, toolCall };
}

const toolContext = { systemPrompt: "", messages: [] };

function createUiContext(confirm: ExtensionUIContext["confirm"]): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
	} as unknown as ExtensionUIContext;
}

describe("AgentSession permission rules", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `piki-permission-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("allows ask rules when the UI confirms", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			permissionRules: [{ tool: "bash", action: "ask", message: "Confirm bash" }],
		});
		await session.bindExtensions({ uiContext: createUiContext(async () => true), mode: "tui" });

		const { assistantMessage, toolCall } = createAssistantWithToolCall("bash", { command: "echo ok" });
		const result = await session.agent.beforeToolCall?.({
			assistantMessage,
			toolCall,
			args: toolCall.arguments,
			context: toolContext,
		});

		expect(result).toBeUndefined();
		session.dispose();
	});

	it("blocks ask rules when the UI denies", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			permissionRules: [{ tool: "bash", action: "ask", message: "Confirm bash" }],
		});
		await session.bindExtensions({ uiContext: createUiContext(async () => false), mode: "tui" });

		const { assistantMessage, toolCall } = createAssistantWithToolCall("bash", { command: "echo ok" });
		const result = await session.agent.beforeToolCall?.({
			assistantMessage,
			toolCall,
			args: toolCall.arguments,
			context: toolContext,
		});

		expect(result?.immediateResultIsError).toBe(true);
		expect((result?.immediateResult?.content[0] as { text: string }).text).toContain("user denied confirmation");
		session.dispose();
	});

	it("supports delegated permission decisions", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			permissionRules: [{ tool: "bash", action: "delegate", to: "test-policy" }],
			permissionDelegate: async (_decision, _toolName, input) => input.command === "echo ok",
		});

		const allowed = createAssistantWithToolCall("bash", { command: "echo ok" });
		await expect(
			session.agent.beforeToolCall?.({
				assistantMessage: allowed.assistantMessage,
				toolCall: allowed.toolCall,
				args: allowed.toolCall.arguments,
				context: toolContext,
			}),
		).resolves.toBeUndefined();

		const denied = createAssistantWithToolCall("bash", { command: "echo no" });
		const result = await session.agent.beforeToolCall?.({
			assistantMessage: denied.assistantMessage,
			toolCall: denied.toolCall,
			args: denied.toolCall.arguments,
			context: toolContext,
		});
		expect(result?.immediateResultIsError).toBe(true);

		session.dispose();
	});
});
