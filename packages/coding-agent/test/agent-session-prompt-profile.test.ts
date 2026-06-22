import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
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
		tempDir = join(tmpdir(), `pi-prompt-profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
			// Starts on Claude -> default profile (verbose identity present)
			expect(session.systemPrompt).toContain("You are an expert coding assistant operating inside pi");
			expect(session.systemPrompt).not.toContain("You are pi, an interactive coding agent.");

			// Switch to GLM -> open-source-explicit profile rebuilds the prompt
			await session.setModel(glmModel as Model<"openai-completions">);
			expect(session.systemPrompt).toContain("You are pi, an interactive coding agent.");
			expect(session.systemPrompt).toContain("Tool usage:");
			expect(session.systemPrompt).not.toContain("You are an expert coding assistant operating inside pi");

			// Switch back to Claude -> default profile restored. The prompt content
			// is deterministic, so this reproduces the original default prompt; what
			// matters is that the open-source-explicit sections are gone again.
			await session.setModel(claudeModel as Model<"anthropic-messages">);
			expect(session.systemPrompt).toContain("You are an expert coding assistant operating inside pi");
			expect(session.systemPrompt).not.toContain("Tool usage:");
			expect(session.systemPrompt).not.toContain("You are pi, an interactive coding agent.");
		} finally {
			session.dispose();
		}
	});
});
