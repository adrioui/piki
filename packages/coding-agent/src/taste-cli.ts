import { type AgentSessionServices, createAgentSessionServices } from "./core/agent-session-services.ts";
import { resolvePreferredAuxModel } from "./core/aux-model.ts";
import { type AgentId, discoverSessions, extractBatchedPrompts } from "./core/session-importer.ts";
import { TasteProfileStore, type TasteScope } from "./core/taste.ts";
import { runLearnPipeline, runLearnPipelineFromSignals } from "./core/taste-git-history.ts";
import { loadTasteOnboardingState, saveTasteOnboardingState } from "./core/taste-onboarding.ts";
import { parsePackageSlug, TasteRegistry } from "./core/taste-registry.ts";
import { resolvePath } from "./utils/paths.ts";

function takeFlag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("-")) {
		throw new Error(`${name} requires a value`);
	}
	args.splice(index, 2);
	return value;
}

function takeBooleanFlag(args: string[], name: string): boolean {
	const index = args.indexOf(name);
	if (index === -1) return false;
	args.splice(index, 1);
	return true;
}

function resolveTasteModel(services: AgentSessionServices, provider?: string, modelId?: string) {
	if (!provider && modelId?.startsWith("commandcode/")) {
		provider = "commandcode";
		modelId = modelId.slice("commandcode/".length);
	}
	if (provider && modelId) {
		const match = services.modelRegistry
			.getAvailable()
			.find((model) => model.provider === provider && model.id === modelId);
		if (!match) {
			throw new Error(`Model not available: ${provider}/${modelId}`);
		}
		return match;
	}
	if (provider) {
		const match = services.modelRegistry.getAvailable().find((model) => model.provider === provider);
		if (!match) {
			throw new Error(`No configured models available for provider "${provider}"`);
		}
		return match;
	}
	return resolvePreferredAuxModel(services);
}

export async function handleTasteCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "taste") return false;

	const [, subcommand = "status", ...rest] = args;
	const mutableArgs = [...rest];
	const provider = takeFlag(mutableArgs, "--provider");
	const modelId = takeFlag(mutableArgs, "--model");
	const maxCommits = Number.parseInt(takeFlag(mutableArgs, "--max-commits") ?? "200", 10);
	const maxSignals = Number.parseInt(takeFlag(mutableArgs, "--max-signals") ?? "50", 10);
	const branch = takeFlag(mutableArgs, "--branch");
	const project = takeBooleanFlag(mutableArgs, "--project");
	const global = takeBooleanFlag(mutableArgs, "--global");
	const scope: TasteScope = project ? "project" : global ? "global" : "auto";
	// For push/pull, the first positional arg is the slug, not a workspace path
	const pushPullSubcommands = new Set(["push", "pull", "registry-list"]);
	const workspace = pushPullSubcommands.has(subcommand)
		? resolvePath(process.cwd())
		: resolvePath(mutableArgs[0] ?? process.cwd());
	const store = new TasteProfileStore(undefined, scope);

	if (subcommand === "status") {
		console.log(JSON.stringify(store.status(workspace), null, 2));
		return true;
	}

	if (subcommand === "show") {
		console.log(store.getProfile(workspace) ?? "");
		return true;
	}

	if (subcommand === "list") {
		console.log(JSON.stringify(store.listProfiles(), null, 2));
		return true;
	}

	if (subcommand === "open") {
		store.ensureWorkspace(workspace);
		console.log(store.getProfilePath(workspace));
		return true;
	}

	if (subcommand === "lint") {
		console.log(JSON.stringify(store.lint(workspace), null, 2));
		process.exitCode = store.lint(workspace).valid ? 0 : 1;
		return true;
	}

	if (subcommand === "reorganize") {
		console.log(JSON.stringify(store.reorganize(workspace), null, 2));
		return true;
	}

	if (subcommand === "learn") {
		const source = mutableArgs[0] ?? process.cwd();
		const sourceIsLocal = !/^(https?:|git@|ssh:)/.test(source);
		const cwd = sourceIsLocal ? resolvePath(source) : process.cwd();
		const services = await createAgentSessionServices({ cwd });
		const model = resolveTasteModel(services, provider, modelId);
		const result = await runLearnPipeline({
			source,
			services,
			model,
			sessionId: `taste-${Date.now()}`,
			maxCommits,
			maxSignals,
			branch,
			destinationCwd: cwd,
			scope,
		});
		console.log(JSON.stringify(result, null, 2));
		return true;
	}

	if (subcommand === "learn-from-sessions") {
		const agentFilter = mutableArgs[0] as AgentId | undefined;
		const sessions = discoverSessions(agentFilter);
		if (sessions.length === 0) {
			console.log(JSON.stringify({ discovered: 0, message: "No sessions found from any agent." }, null, 2));
			return true;
		}
		const batched = extractBatchedPrompts(sessions);
		const services = await createAgentSessionServices({ cwd: workspace });
		const model = resolveTasteModel(services, provider, modelId);
		let learned = 0;
		let skipped = 0;
		const errors: string[] = [];
		const onboardingState = loadTasteOnboardingState(workspace);
		for (const entry of batched) {
			const alreadyLearned = onboardingState.learnedSessions[entry.agent] ?? [];
			if (alreadyLearned.includes(entry.sessionPath)) {
				skipped++;
				continue;
			}
			for (const batch of entry.batches) {
				try {
					await runLearnPipelineFromSignals({
						signals: [batch],
						services,
						model,
						sessionId: `taste-import-${Date.now()}`,
						destinationCwd: workspace,
						scope,
						systemPrompt: [
							"You infer durable coding taste from prior user prompts across coding-agent sessions.",
							"Use only repeated or strongly implied preferences from the prompts.",
							"Return Command-Code markdown only:",
							"# Code Style",
							"- <rule>. confidence: <0.00-1.00>",
							"Group rules under concise # headers. Capture no secrets or one-off task facts.",
						].join("\n"),
					});
					learned++;
				} catch (err) {
					skipped++;
					errors.push(`${entry.agent}/${entry.sessionPath}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			const learnedList = onboardingState.learnedSessions[entry.agent] ?? [];
			learnedList.push(entry.sessionPath);
			onboardingState.learnedSessions[entry.agent] = learnedList;
		}
		onboardingState.lastLearningDate = new Date().toISOString();
		if (learned > 0) onboardingState.completed = true;
		saveTasteOnboardingState(workspace, onboardingState);
		console.log(JSON.stringify({ discovered: sessions.length, learned, skipped, errors }, null, 2));
		return true;
	}

	if (subcommand === "push") {
		const slug = mutableArgs[0];
		if (!slug)
			throw new Error("Usage: taste push <namespace/name> [--visibility public|private] [--description ...]");
		const { namespace, name } = parsePackageSlug(slug);
		const content = store.getProfile(workspace);
		if (!content) throw new Error(`No taste profile found at ${store.getProfilePath(workspace)}`);
		const visibility = (takeFlag(mutableArgs, "--visibility") as "public" | "private") ?? "private";
		const description = takeFlag(mutableArgs, "--description");
		const registry = new TasteRegistry();
		const result = registry.push({
			namespace,
			name,
			content,
			visibility,
			description,
		});
		console.log(JSON.stringify(result, null, 2));
		return true;
	}

	if (subcommand === "pull") {
		const slug = mutableArgs[0];
		if (!slug) throw new Error("Usage: taste pull <namespace/name>");
		const { namespace, name } = parsePackageSlug(slug);
		const registry = new TasteRegistry();
		const destDir = store.getWorkspaceDir(workspace);
		const result = registry.pull(namespace, name, destDir);
		console.log(JSON.stringify(result, null, 2));
		return true;
	}

	if (subcommand === "registry-list") {
		const registry = new TasteRegistry();
		const ns = takeFlag(mutableArgs, "--namespace");
		const vis = takeFlag(mutableArgs, "--visibility") as "public" | "private" | undefined;
		const entries = registry.list({ namespace: ns, visibility: vis });
		console.log(
			JSON.stringify(
				entries.map((e) => ({
					slug: `${e.package.namespace}/${e.package.name}`,
					version: e.package.version,
					visibility: e.package.visibility,
					description: e.package.description,
				})),
				null,
				2,
			),
		);
		return true;
	}

	throw new Error(`Unknown taste subcommand: ${subcommand}`);
}
