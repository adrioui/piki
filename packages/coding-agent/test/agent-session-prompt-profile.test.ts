import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@piki/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("AgentSession prompt profile on model switch", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `piki-prompt-profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rebuilds the system prompt when setModel crosses the default/open-source-explicit boundary", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));

		// Configure auth for both providers so setModel does not throw.
		authStorage.set("anthropic", { type: "api_key", key: "test-key" });
		authStorage.set("zai", { type: "api_key", key: "test-key" });

		const claudeModel = modelRegistry.find("anthropic", "claude-sonnet-4-5")!;
		const glmModel = modelRegistry.find("zai", "glm-4.7")!;
		expect(claudeModel).toBeTruthy();
		expect(glmModel).toBeTruthy();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: claudeModel as Model<"anthropic-messages">,
			settingsManager,
			sessionManager,
			resourceLoader,
			authStorage,
			modelRegistry,
		});

		try {
			// Starts on Claude -> body is LEADER_PROMPT; default lineage tuning is the tail.
			expect(session.systemPrompt).toContain("You are piki, a highly capable coding agent");
			// The default-family tuning (tail) is present but NOT the first instruction.
			expect(session.systemPrompt).toContain("You are an expert coding assistant operating inside piki");
			// Leader identity precedes the family tuning.
			expect(session.systemPrompt.indexOf("You are piki, a highly capable coding agent")).toBeLessThan(
				session.systemPrompt.indexOf("You are an expert coding assistant operating inside piki"),
			);

			// Switch to GLM -> open-source-explicit tail tuning; body unchanged (still LEADER_PROMPT).
			await session.setModel(glmModel as Model<"openai-completions">);
			expect(session.systemPrompt).toContain("You are piki, a highly capable coding agent");
			expect(session.systemPrompt).toContain("You are piki, an interactive coding agent.");
			expect(session.systemPrompt).toContain("Tool usage:");
			expect(session.systemPrompt).toContain("piki coding harness");

			// Switch back to Claude -> default tail tuning restored, body still LEADER_PROMPT.
			await session.setModel(claudeModel as Model<"anthropic-messages">);
			expect(session.systemPrompt).toContain("You are piki, a highly capable coding agent");
			expect(session.systemPrompt).toContain("You are an expert coding assistant operating inside piki");
			expect(session.systemPrompt).not.toContain("Tool usage:");
		} finally {
			session.dispose();
		}
	});
});
