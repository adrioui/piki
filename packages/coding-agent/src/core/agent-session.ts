/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Agent, AgentEvent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from "@piki/agent-core";
import { composePayloadHooks, createGrammarInjector, createStructuredOutputInjector } from "@piki/ai";
import type { AssistantMessage, Context, ImageContent, Message, Model, TextContent } from "@piki/ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	modelsAreEqual,
	resetApiProviders,
	streamSimple,
} from "@piki/ai/compat";
import {
	CHARS_PER_TOKEN_LOWER,
	COMPACT_MAX_FILE_CHARS,
	COMPACT_MAX_FILES,
	COMPACTION_FALLBACK_KEEP_RATIO,
	COMPACTION_MAX_RETRIES,
	OUTPUT_TOKEN_RESERVE,
	ROLE_DEFINITIONS,
} from "@piki/event-core";
import { renderLeaderSystemPrompt } from "@piki/roles";
import { formatSkillsForPrompt } from "@piki/skills";
import { Effect } from "effect";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { handleTasteCommand } from "../taste-cli.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { formatToolResultForModel } from "./activity-formatter.ts";
import { decideAssistantCommit } from "./assistant-commit-policy.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	COMPACTION_REFLECTION_PROMPT,
	COMPACTION_TIMEOUT_MS,
	type CompactionDetails,
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	computeContinuationCharThreshold,
	computeSoftCap,
	estimateContextChars,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { expandAtFileIncludes } from "./context-includes.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { EpochInterruptCoordinator } from "./epoch-interrupt-coordinator.ts";
import { ErrorRepeatGuard } from "./error-repeat-guard.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { collectGitState, type GitState } from "./git-state.ts";
import { IdenticalContinueTracker } from "./identical-continue-tracker.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { classifyError, computeJitteredDelay } from "./permissions/error-classifier.ts";
import { checkInputForGuardedPaths } from "./permissions/guarded-paths.ts";
import { evaluatePermission, type PermissionDecision, type PermissionRule } from "./permissions/permission-gate.ts";
import { getRolePolicyRules } from "./permissions/role-policy.ts";
import { classifyPromptVariant } from "./prompt-family.ts";
import { expandPromptTemplate, type PromptTemplate, parseCommandArgs } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import type { SkillFilterRole } from "./role-context.ts";
import type { ScratchpadManager } from "./scratchpad-manager.ts";
import type { SessionCancellationScope } from "./session-cancellation-scope.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import { getForkEntriesForSession, getForkMetaForSession } from "./session-orchestrator.ts";
import { readSessionContext } from "./session-reader.ts";
import { createSessionRuntimeServices, type SessionRuntimeServicesShape } from "./session-runtime-services.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createCheckpointId, createSnapshot, isGitRepo } from "./snapshot.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt, buildSystemPromptTail } from "./system-prompt.ts";
import { generateSessionTitle, type TitleWorkerEvent } from "./title-worker.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createCheckpointChangesToolDefinition } from "./tools/checkpoint-changes.ts";
import { createCreateTaskToolDefinition } from "./tools/create-task.ts";
import { createFinishGoalToolDefinition } from "./tools/finish-goal.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createKillWorkerToolDefinition } from "./tools/kill-worker.ts";
import { createMessageAdvisorToolDefinition } from "./tools/message-advisor.ts";
import { createMessageWorkerToolDefinition } from "./tools/message-worker.ts";
import { createReassignWorkerToolDefinition } from "./tools/reassign-worker.ts";
import { createRestoreSnapshotToolDefinition } from "./tools/restore-snapshot.ts";
import { createScratchpadLoadToolDefinition } from "./tools/scratchpad-load.ts";
import { createScratchpadSaveToolDefinition } from "./tools/scratchpad-save.ts";
import { createSpawnWorkerToolDefinition } from "./tools/spawn-worker.ts";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "./tools/tool-definition-wrapper.ts";
import { createUpdateTaskToolDefinition } from "./tools/update-task.ts";
import { createWebFetchToolDefinition } from "./tools/web-fetch.ts";
import { createWebSearchToolDefinition } from "./tools/web-search.ts";
import type { WorkerTool } from "./worker-session.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "session_shutdown"; reason: "reload" | "dispose" }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| { type: "skill_activated"; skillName: string; skillPath: string; hasArgs: boolean }
	| {
			type: "runtime_event";
			runtimeEventType: string;
			payload: Record<string, unknown>;
			sequence?: number;
	  };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Whether allowlisted tools should all be active initially. Default: true for compatibility. */
	autoActivateAllowedTools?: boolean;
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/** When true, forbid/mass-destructive shell classification and destructive built-in rules are allowed (alpha22 --disable-shell-safeguards). */
	disableShellSafeguards?: boolean;
	/** When true, role-policy out-of-cwd write rules are skipped for spawned workers (alpha22 --disable-cwd-safeguards). Leader is unaffected. */
	disableCwdSafeguards?: boolean;
	/** Initial goal objective (alpha22 --goal). Seeds the Goal projection at session init. */
	goal?: string;
	/** Optional permission rules evaluated before built-in policy. */
	permissionRules?: PermissionRule[];
	/** Optional delegate for permission rules with action="delegate". */
	permissionDelegate?: (
		decision: PermissionDecision,
		toolName: string,
		input: Record<string, unknown>,
	) => Promise<boolean | { permitted: boolean; reason?: string }>;
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
	}>;

	/** Runtime per-role model overrides (survive reload via settings.roleModels). */
	private _roleModelOverrides: Record<string, string> = {};

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _errorRepeatGuard = new ErrorRepeatGuard();
	private _continueTracker = new IdenticalContinueTracker();
	private readonly _epochCoordinator = new EpochInterruptCoordinator();

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];
	private readonly _cancellationScope: SessionCancellationScope;

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	// Leader max-turns cap (per session run, survives reload via settings)
	private _leaderMaxTurns: number;
	private _leaderTurnCount = 0;
	private _leaderTurnWarningSent = false;
	private _leaderTurnsStopped = false;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _autoActivateAllowedTools = true;
	private _excludedToolNames?: Set<string>;
	private _permissionRules: PermissionRule[] = [];
	private _disableShellSafeguards = false;
	private _disableCwdSafeguards = false;
	private _goal?: string;
	private _permissionDelegate?: (
		decision: PermissionDecision,
		toolName: string,
		input: Record<string, unknown>,
	) => Promise<boolean | { permitted: boolean; reason?: string }>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;

	// Current git state, refreshed every turn and injected into the system prompt.
	private _gitState: GitState | undefined;

	// Auto-snapshot state
	private _snapshotEnabled = false;

	// Scratchpad state
	private _scratchpad: ScratchpadManager;
	private _runtimeServices: SessionRuntimeServicesShape;

	// Guidance discovery state (Phase 2)
	private _touchedFiles: Set<string> = new Set();
	private _skillFilterRole: SkillFilterRole | undefined;

	/**
	 * Set the role for skill filtering in the system prompt.
	 * When set, only skills visible to this role are included.
	 */
	setSkillFilterRole(role: SkillFilterRole | undefined): void {
		this._skillFilterRole = role;
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._roleModelOverrides = this.settingsManager.getRoleModels();
		this._leaderMaxTurns = this.settingsManager.getLeaderMaxTurns();
		this._customTools = config.customTools ?? [];
		this._resourceLoader = config.resourceLoader;
		this._cwd = config.cwd;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._autoActivateAllowedTools = config.autoActivateAllowedTools ?? true;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._permissionRules = config.permissionRules ?? [];
		this._disableShellSafeguards = config.disableShellSafeguards ?? false;
		this._disableCwdSafeguards = config.disableCwdSafeguards ?? false;
		this._goal = config.goal;
		this._permissionDelegate = config.permissionDelegate;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? {
			type: "session_start",
			reason: "startup",
		};

		this._runtimeServices = createSessionRuntimeServices({
			cwd: config.cwd,
			sessionId: this.sessionId,
			publishRuntimeEvent: (type, payload) => this.emitRuntimeEvent({ type, payload }),
		});
		this._scratchpad = this._runtimeServices.scratchpad;
		this._cancellationScope = this._runtimeServices.cancellationScope;

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installEpochCheck();
		this._installPrepareNextTurn();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		this._gitState = collectGitState(this._cwd);
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return {
				apiKey: result.apiKey,
				headers: result.headers,
				env: result.env,
			};
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFn === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers, env: result.env } : {};
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const input = args as Record<string, unknown>;

			// Permission gate check: evaluate built-in and user rules
			const interactive = this._extensionRunner?.hasUI?.() ?? true;
			const knownTools = Array.from(this._toolRegistry.keys());
			const permissionDecision = evaluatePermission(toolCall.name, input, {
				userRules: this._permissionRules,
				interactive,
				context: "thread",
				knownTools,
				// G1/G2: apply the leader role policy so write/edit/edit-diff are
				// bounded by the cwd write-boundary, and `--disable-cwd-safeguards`
				// becomes a real (independent) toggle for the leader. Reuses the
				// existing, already-correct getRolePolicyRules.
				roleId: "leader",
				rolePolicyRules: getRolePolicyRules("leader", this._cwd, this._scratchpad.getRootDir(), {
					disableCwdSafeguards: this._disableCwdSafeguards,
					disableShellSafeguards: this._disableShellSafeguards,
				}),
				scratchpadPath: this._scratchpad.getRootDir(),
				disableShellSafeguards: this._disableShellSafeguards,
				cwd: this._cwd,
			});

			let permissionOverrideAllowed = false;
			if (permissionDecision.action === "ask" && interactive) {
				const approved = await this._extensionRunner
					.getUIContext()
					.confirm(
						"Approve tool call?",
						`Tool: ${toolCall.name}\nReason: ${permissionDecision.reason ?? "Permission rule requires confirmation."}`,
					);
				if (!approved) {
					return {
						immediateResult: {
							content: [
								{
									type: "text" as const,
									text: `[Permission Gate] Tool \`${toolCall.name}\` was blocked. Reason: user denied confirmation.`,
								},
							],
							details: undefined,
						},
						immediateResultIsError: true,
					};
				}
				permissionOverrideAllowed = true;
			} else if (permissionDecision.action === "delegate" && this._permissionDelegate) {
				const delegated = await this._permissionDelegate(permissionDecision, toolCall.name, input);
				const delegatedDecision =
					typeof delegated === "boolean" ? { permitted: delegated, reason: permissionDecision.reason } : delegated;
				if (!delegatedDecision.permitted) {
					return {
						immediateResult: {
							content: [
								{
									type: "text" as const,
									text: `[Permission Gate] Tool \`${toolCall.name}\` was blocked. Reason: ${delegatedDecision.reason ?? permissionDecision.reason ?? "delegated policy denied the call"}`,
								},
							],
							details: undefined,
						},
						immediateResultIsError: true,
					};
				}
				permissionOverrideAllowed = true;
			}

			if (!permissionDecision.permitted && !permissionOverrideAllowed) {
				return {
					immediateResult: {
						content: [
							{
								type: "text" as const,
								text: `[Permission Gate] Tool \`${toolCall.name}\` was blocked. Reason: ${permissionDecision.reason ?? "No rule matched"}`,
							},
						],
						details: undefined,
					},
					immediateResultIsError: true,
				};
			}

			// Guarded path check: block mutating tools on sensitive paths
			const mutatingTools = new Set(["edit", "write", "bash", "edit-diff", "restore_snapshot"]);
			if (mutatingTools.has(toolCall.name)) {
				const guardedPathResult = checkInputForGuardedPaths(input);
				if (guardedPathResult) {
					return {
						immediateResult: {
							content: [
								{
									type: "text" as const,
									text: `[Permission Gate] Tool \`${toolCall.name}\` was blocked on guarded path \`${guardedPathResult.path}\` (matched pattern: \`${guardedPathResult.pattern}\`). This path is protected from mutation.`,
								},
							],
							details: undefined,
						},
						immediateResultIsError: true,
					};
				}
			}

			// Extension tool_call hooks
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call") && !runner.hasHandlers("before_tool_call")) {
				return undefined;
			}

			try {
				const toolCallResult = await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input,
				});

				// Handle middleware synthesize result: return immediate result to bypass execution
				if (toolCallResult?.synthesizeResult) {
					return {
						immediateResult: toolCallResult.synthesizeResult,
						immediateResultIsError: toolCallResult.synthesizeIsError,
					};
				}

				return toolCallResult;
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			// Dynamic project-instruction discovery: after a successful edit/write,
			// re-scan for AGENTS.md / CLAUDE.md from cwd up to root. The scan dedupes
			// and is local/deterministic. If the discovered set changed, rebuild the
			// base system prompt so the next turn sees the new instructions. This is
			// independent of extension tool_result handlers below.
			if (!isError && (toolCall.name === "edit" || toolCall.name === "write")) {
				this._maybeReloadContextFiles();
				// Also track the file for glob-scoped guidance filtering
				const filePath = this._extractFilePathFromArgs(args);
				if (filePath) {
					this._trackTouchedFile(filePath);
				}
			}

			// Guidance discovery: track files read by the agent for glob-scoped filtering
			if (!isError && toolCall.name === "read") {
				const filePath = this._extractFilePathFromArgs(args);
				if (filePath) {
					this._trackTouchedFile(filePath);
				}
			}

			const repeatGuardResult =
				isError && (result.content ?? []).some((content) => content.type === "text")
					? this._errorRepeatGuard.recordError(
							toolCall.name,
							args,
							(result.content ?? [])
								.filter((content) => content.type === "text")
								.map((content) => content.text ?? "")
								.join("\n"),
						)
					: undefined;
			if (repeatGuardResult?.shouldStop) {
				return {
					content: [
						{
							type: "text",
							text:
								`[${toolCall.name}] The same tool call has failed ${repeatGuardResult.repeatCount} times with the same error.\n` +
								"Stop retrying the identical call. Change approach, inspect related context, or ask the user if blocked.",
						},
					],
					isError: true,
					terminate: true,
				};
			}

			const resultSidecarPath = this._persistToolResultSidecar(toolCall.id, toolCall.name, args, result, isError);
			const formattedContent = this._withToolResultSidecarNote(
				formatToolResultForModel(toolCall.name, args, result, isError),
				this._shouldExposeToolResultSidecar(result) ? resultSidecarPath : undefined,
			);

			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_result") && !runner.hasHandlers("after_tool_call")) {
				return formattedContent ? { content: formattedContent } : undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: formattedContent ?? result.content,
				details: result.details,
				isError,
			});

			if (!hookResult) {
				return formattedContent ? { content: formattedContent } : undefined;
			}

			const hookResultContent = formattedContent
				? (formatToolResultForModel(
						toolCall.name,
						args,
						{
							content: hookResult.content ?? formattedContent,
							details: hookResult.details,
						},
						hookResult.isError ?? isError,
					) ??
					hookResult.content ??
					formattedContent)
				: (hookResult.content ?? result.content);

			return {
				content: hookResultContent,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
			};
		};
	}

	/**
	 * Re-snapshot tools and system prompt each turn so mid-run changes
	 * (pi.setActiveTools, system-prompt overrides) reach the next provider
	 * request within the same run. Without this, the agent loop freezes the
	 * context snapshot taken at prompt() start.
	 */
	private _installPrepareNextTurn(): void {
		this.agent.prepareNextTurn = () => {
			return {
				context: {
					systemPrompt: this.agent.state.systemPrompt,
					messages: this.agent.state.messages.slice(),
					tools: this.agent.state.tools.slice(),
				},
			};
		};
	}

	/** Token captured at the start of each turn, used by the agent loop to detect staleness. */
	private _turnEpochToken: ReturnType<EpochInterruptCoordinator["captureToken"]> | undefined;

	/**
	 * Wire the epoch staleness check into the agent loop.
	 * The agent loop calls checkEpoch at key points (after streaming, after tool
	 * execution, before continuing) to detect stale results from interrupted turns.
	 * The token is captured once at turn start (in prompt()) and checked throughout.
	 */
	private _installEpochCheck(): void {
		this.agent.checkEpoch = () => {
			const token = this._turnEpochToken;
			if (!token) return true;
			return this._epochCoordinator.isTokenCurrent(token);
		};
	}

	private _persistToolResultSidecar(
		toolCallId: string,
		toolName: string,
		args: unknown,
		result: { content: unknown; details?: unknown },
		isError: boolean,
	): string | undefined {
		try {
			return Effect.runSync(
				this._runtimeServices.saveToolResultSidecar({
					toolCallId,
					toolName,
					args,
					result,
					isError,
				}),
			);
		} catch {
			return undefined;
		}
	}

	private _withToolResultSidecarNote(
		content: (TextContent | ImageContent)[] | undefined,
		resultSidecarPath: string | undefined,
	): (TextContent | ImageContent)[] | undefined {
		if (!content || !resultSidecarPath) return content;
		return content.map((part, index) =>
			index === content.length - 1 && part.type === "text"
				? {
						...part,
						text: `${part.text ?? ""}\n\n[Full tool result saved to: ${resultSidecarPath}]`,
					}
				: part,
		);
	}

	private _shouldExposeToolResultSidecar(result: { content: unknown; details?: unknown }): boolean {
		const textBytes = Array.isArray(result.content)
			? result.content.reduce((total, part) => {
					if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
						return total + Buffer.byteLength(typeof part.text === "string" ? part.text : "", "utf-8");
					}
					return total;
				}, 0)
			: 0;
		return textBytes > 100 * 1024;
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	/** Emit a persisted runtime event to UI subscribers without adding it to model/session context. */
	emitRuntimeEvent(event: { type: string; payload: Record<string, unknown>; sequence?: number }): void {
		this._emit({
			type: "runtime_event",
			runtimeEventType: event.type,
			payload: event.payload,
			sequence: event.sequence,
		});
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;
	private _pendingToolValidationFeedback: string | undefined = undefined;
	// Base onPayload from sdk.ts, captured once before grammar injectors are composed.
	// Re-composed from this base each time the active tool set changes.
	private _baseOnPayload:
		| ((payload: unknown, model: Model<any>) => unknown | undefined | Promise<unknown | undefined>)
		| undefined;
	private _baseOnPayloadCaptured = false;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			const messageText = this._getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		const willRetry = event.type === "agent_end" ? this._willRetryAfterAgentEnd(event) : false;

		// Agent-core emits agent_end for each low-level run. Auto-retry turns are
		// internal continuations, so extension agent_end handlers must wait for the
		// final run or they can collapse/summarize before failover retries happen.
		if (event.type !== "agent_end" || !willRetry) {
			await this._emitExtensionEvent(event);
		}

		// Clear the epoch token when the agent run completes (no more retry pending)
		if (event.type === "agent_end" && !willRetry) {
			this._turnEpochToken = undefined;

			// Trigger title generation after the first turn completes.
			// This fires-and-forgets: title generation is non-blocking.
			// Use <= 2 to handle cases where the first prompt is tool-call-only
			// (title text arrives on the second agent_end within the first turn).
			// generateSessionTitle already guards against duplicate titles.
			if (this._turnIndex <= 2) {
				generateSessionTitle({
					sessionManager: this.sessionManager,
					modelRegistry: this._modelRegistry,
					settingsManager: this.settingsManager,
					onEvent: (e: TitleWorkerEvent) => {
						this.emitRuntimeEvent({
							type: `title.${e.type}`,
							payload: e as unknown as Record<string, unknown>,
						});
					},
				}).catch(() => {
					// Title generation is best-effort; swallow errors.
				});
			}
		}

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(
					event.message,
					event.message.role === "assistant"
						? { llmFailed: (event.message as AssistantMessage).stopReason === "error" }
						: undefined,
				);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for retry handling after agent_end
			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				// When a tool-validation abort is pending, override the aborted message
				// so _isRetryableError recognizes it as a retryable tool_validation error.
				if (this._pendingToolValidationFeedback !== undefined) {
					this._lastAssistantMessage = {
						...assistantMsg,
						stopReason: "error" as const,
						errorMessage: this._pendingToolValidationFeedback,
					};
					this._pendingToolValidationFeedback = undefined;
				} else {
					this._lastAssistantMessage = assistantMsg;
				}
				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Extract text content from a message */
	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	/** Find the last assistant message in agent state (including aborted ones). */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({
				type: "agent_end",
				messages: event.messages,
			});
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;

			// Leader max-turns cap: stop the agent once the cap is reached and
			// steer it toward a final report as it approaches the cap.
			if (!this._leaderTurnsStopped) {
				this._leaderTurnCount++;
				if (this._leaderTurnCount >= this._leaderMaxTurns) {
					this._leaderTurnsStopped = true;
					this.emitRuntimeEvent({
						type: "leader_max_turns",
						payload: {
							maxTurns: this._leaderMaxTurns,
							turnIndex: this._leaderTurnCount,
						},
					});
					this.agent.abort();
				} else if (!this._leaderTurnWarningSent && this._leaderTurnCount >= this._leaderMaxTurns - 3) {
					this._leaderTurnWarningSent = true;
					await this.agent.steer({
						role: "user",
						content:
							"[System: You are near the leader turn limit. Stop starting new exploration. Return a concise final report now with: outcome, evidence gathered, commands/files checked, verification status, and remaining gaps. If incomplete, say exactly what remains instead of continuing.]",
						timestamp: Date.now(),
					} as AgentMessage);
				}
			}
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this._emit({ type: "session_shutdown", reason: "dispose" });
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
			Effect.runSync(this._runtimeServices.close());
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured piki or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Durable scratchpad for session artifacts. */
	get scratchpad(): ScratchpadManager {
		return this._scratchpad;
	}

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	get turnEpoch(): number {
		return this._epochCoordinator.current().value;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getExecutableWorkerTools(): WorkerTool[] {
		return Array.from(this._toolRegistry.values()).map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			prepareArguments: tool.prepareArguments,
			execute: (id, args, signal, onUpdate) => {
				const input = args as Record<string, unknown>;
				const mutatingTools = new Set(["edit", "write", "bash", "edit-diff", "restore_snapshot"]);
				if (mutatingTools.has(tool.name)) {
					const guardedPathResult = checkInputForGuardedPaths(input);
					if (guardedPathResult) {
						throw new Error(
							`[Permission Gate] Worker tool \`${tool.name}\` blocked on guarded path \`${guardedPathResult.path}\`.`,
						);
					}
				}
				return tool.execute(id, args, signal, onUpdate);
			},
		}));
	}

	getUserPermissionRules(): PermissionRule[] {
		return [...this._permissionRules];
	}

	/** Whether shell safeguards are disabled for this session (alpha22 --disable-shell-safeguards). */
	get disableShellSafeguards(): boolean {
		return this._disableShellSafeguards;
	}

	/** Whether cwd safeguards are disabled for spawned workers (alpha22 --disable-cwd-safeguards). */
	get disableCwdSafeguards(): boolean {
		return this._disableCwdSafeguards;
	}

	/** Initial goal objective (alpha22 --goal), if provided. */
	get goal(): string | undefined {
		return this._goal;
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Compose grammar + structured-output injectors with the base onPayload hook.
		// Captures the original onPayload (from sdk.ts) once, then re-composes on each tool change.
		if (!this._baseOnPayloadCaptured) {
			this._baseOnPayload = this.agent.onPayload;
			this._baseOnPayloadCaptured = true;
		}
		const toolSchemas = tools.map((t) => t.parameters);
		this.agent.onPayload = composePayloadHooks([
			createGrammarInjector(toolSchemas),
			createStructuredOutputInjector(toolSchemas),
			this._baseOnPayload,
		]);

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return this._compactionAbortController !== undefined || this._branchSummaryAbortController !== undefined;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/**
	 * Read-only view of the per-fork worker entries captured during this session,
	 * used to populate ATIF `subagent_trajectories`. Reached via the module-level
	 * `ORCHESTRATORS` map to avoid holding a direct orchestrator reference.
	 */
	getForkEntries(): Map<string, SessionEntry[]> {
		return getForkEntriesForSession(this.sessionId);
	}

	/**
	 * Read-only view of the per-fork real fork metadata captured during this
	 * session, used to populate ATIF spawn-step real `agentId`/`role`/`taskId`/
	 * `mode`/`message`. Reached via the module-level `ORCHESTRATORS` map to
	 * avoid holding a direct orchestrator reference.
	 */
	getForkMeta(): Map<
		string,
		{
			agentId: string;
			parentForkId: string | null;
			role: string;
			taskId: string | undefined;
			mode: string;
			message: string | undefined;
		}
	> {
		return getForkMetaForSession(this.sessionId);
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
	}> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}
		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		// The canonical leader identity (LEADER_PROMPT) is the BODY of the
		// system prompt. The variant/lineage tuning text is appended as the
		// TAIL after the leader body, matching Magnitude alpha22's composition.
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;
		const leaderBody = renderLeaderSystemPrompt({
			skills: formatSkillsForPrompt(loadedSkills, { role: this._skillFilterRole ?? "leader" }),
		});

		const tailOptions: BuildSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			provider: this.model?.provider,
			modelId: this.model?.id,
			modelName: this.model?.name,
			role: this._skillFilterRole,
		};

		// Build the variant/lineage tuning tail (tools list + variant guidance,
		// no outer context). Prefer the project/system loader prompt as the
		// customPrompt body when one is provided; otherwise fall back to the
		// canonical leader identity.
		const tailParts: string[] = [];
		if (loaderAppendSystemPrompt.length > 0) tailParts.push(loaderAppendSystemPrompt.join("\n\n"));
		tailParts.push(buildSystemPromptTail(tailOptions));
		const appendSystemPrompt = tailParts.join("\n\n");

		this._baseSystemPromptOptions = {
			...tailOptions,
			skipSkillsInTail: true,
			customPrompt: (loaderSystemPrompt ?? "").length > 0 ? loaderSystemPrompt : leaderBody,
			appendSystemPrompt,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	/**
	 * Format the current git state into a bounded text block for the system
	 * prompt. Mirrors the formatting of `formatEnvironmentSnapshot` but is
	 * refreshed every turn (not just for open-source prompt variants) and
	 * sourced from porcelain v2 status. Returns undefined when not a git repo.
	 */
	private _formatGitStateBlock(): string | undefined {
		const state = this._gitState;
		if (!state) return undefined;
		const lines: string[] = ["Git state:"];
		lines.push(`- git_branch: ${state.branch ?? "(unavailable)"}`);
		if (state.status.length > 0) {
			lines.push("- git_status:");
			for (const entry of state.status.slice(0, 50)) {
				const path = entry.oldPath ? `${entry.oldPath} -> ${entry.path}` : entry.path;
				lines.push(`  ${entry.x}${entry.y} ${path}`);
			}
			if (state.status.length > 50) {
				lines.push(`... (${state.status.length - 50} more entries)`);
			}
		}
		if (state.recentCommits.length > 0) {
			lines.push("- recent_commits:");
			for (const commit of state.recentCommits.slice(0, 10)) {
				lines.push(`  ${commit}`);
			}
		}
		const formatted = lines.join("\n");
		return formatted.length > 8000 ? `${formatted.slice(0, 8000)}\n... (git state truncated)` : formatted;
	}

	/**
	 * Rebuild the base system prompt after a model change, but only when the
	 * prompt variant actually differs. This keeps same-variant models from
	 * churning the prompt on every switch while ensuring a switch into or out
	 * of a model-specific lineage re-renders correctly.
	 */
	private _rebuildBaseSystemPromptFromModel(): void {
		const previousVariant = this._baseSystemPromptOptions.promptVariant;
		const nextVariant = classifyPromptVariant(this.model?.provider, this.model?.id, this.model?.name);
		if (previousVariant === nextVariant) {
			return;
		}
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/**
	 * Re-discover project context files (AGENTS.md / CLAUDE.md) after a file
	 * operation. If the discovered set changed, rebuild the base system prompt so
	 * the next agent turn observes the new instructions. No-op when nothing
	 * changed, keeping this cheap for the common case of editing a non-context
	 * file.
	 */
	private _maybeReloadContextFiles(): void {
		if (!this._resourceLoader.reloadContextFiles()) {
			return;
		}
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/**
	 * Extract file path from tool arguments (read, edit, write tools).
	 * Returns undefined if no file path found.
	 */
	private _extractFilePathFromArgs(args: unknown): string | undefined {
		if (!args || typeof args !== "object") {
			return undefined;
		}
		const record = args as Record<string, unknown>;
		const path = record.file_path ?? record.path;
		return typeof path === "string" ? path : undefined;
	}

	/**
	 * Track a file that was read by the agent. Used for glob-scoped guidance filtering.
	 * When a file is read, check if any glob-scoped AGENTS.md files apply to it.
	 * If new guidance becomes relevant, rebuild the system prompt.
	 */
	private _trackTouchedFile(filePath: string): void {
		const absolutePath = resolvePath(filePath, this._cwd);
		const wasAdded = !this._touchedFiles.has(absolutePath);
		this._touchedFiles.add(absolutePath);

		if (wasAdded) {
			// Check if any glob-scoped guidance now applies to this file
			this._maybeReloadGuidanceForTouchedFiles();
		}
	}

	/**
	 * Check if glob-scoped guidance files now apply to recently touched files.
	 * Rebuilds the system prompt if new guidance becomes relevant.
	 */
	private _maybeReloadGuidanceForTouchedFiles(): void {
		const touchedPaths = Array.from(this._touchedFiles);
		if (touchedPaths.length === 0) {
			return;
		}

		// Pass touched files to resource loader for glob-scoped filtering
		this._resourceLoader.setTouchedFiles(touchedPaths);

		// Reload context files - this will filter AGENTS.md based on glob patterns
		if (!this._resourceLoader.reloadContextFiles()) {
			return;
		}

		// Context files changed, rebuild system prompt
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		try {
			this._continueTracker.reset();
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				if (this._retryAttempt === 0 && this._continueTracker.shouldSkip(this.agent.state.messages)) {
					break;
				}
				await this.agent.continue();
			}
		} finally {
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
			await this._emitAgentSettled();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			// Inject corrective feedback as a steering message for tool-validation retries
			if (msg.errorMessage?.startsWith("tool_validation:")) {
				const feedback = msg.errorMessage.slice("tool_validation:".length).trim();
				if (feedback) {
					await this._queueSteer(feedback);
				}
			}
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// Drain any stale steering messages queued by internal systems (e.g.,
		// thinking governor warning) that were intended for the next model call.
		// The turn completed successfully, so these are no longer needed.
		this._steeringMessages = [];

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// Handle /learn-taste command
			if (expandPromptTemplates && text.trim() === "/learn-taste") {
				preflightResult?.(true);
				await handleTasteCommand(["taste", "learn", this.sessionManager.getCwd()]);
				return;
			}

			if (
				expandPromptTemplates &&
				(text.trim() === "/import-session" || text.trim().startsWith("/import-session "))
			) {
				preflightResult?.(true);
				const args = parseCommandArgs(text.trim().slice("/import-session".length).trim());
				const inputPath = args[0];
				if (!inputPath) {
					throw new Error("Usage: /import-session <path.jsonl>");
				}
				const sessionContext = readSessionContext(resolvePath(inputPath, this._cwd));
				await this.sendCustomMessage(
					{
						customType: "previous-session-context",
						content: [
							"<previous_session_context>",
							`Source: ${sessionContext.path}`,
							`Messages: ${sessionContext.messages.length}`,
							"",
							sessionContext.text,
							"</previous_session_context>",
						].join("\n"),
						display: true,
						details: { path: sessionContext.path, messageCount: sessionContext.messages.length },
					},
					undefined,
				);
				return;
			}

			// Handle /configure-models command
			if (expandPromptTemplates && text.trim() === "/configure-models") {
				preflightResult?.(true);
				await this.sendCustomMessage(
					{
						customType: "advisor-message",
						content:
							"<advisor>Use /settings to configure thinking level and transport. Use 'pi taste learn --provider <p> --model <m>' from the CLI to configure the taste learning model. Multi-agent role-control tools are enabled by default.</advisor>",
						display: false,
					},
					undefined,
				);
				return;
			}

			// Handle /max-turns command: report usage, update the cap, or resume
			// a stopped leader. No-op when given no argument.
			if (expandPromptTemplates && text.trim().startsWith("/max-turns")) {
				preflightResult?.(true);
				const arg = text.trim().slice("/max-turns".length).trim();
				if (arg === "") {
					await this.sendCustomMessage(
						{
							customType: "leader-max-turns",
							content: `Leader turn cap: ${this._leaderMaxTurns}${
								this._leaderTurnsStopped
									? ` (reached at turn ${this._leaderTurnCount})`
									: ` (turn ${this._leaderTurnCount}/${this._leaderMaxTurns} used)`
							}. Use '/max-turns <n>' to change it.`,
							display: true,
						},
						undefined,
					);
					return;
				}
				const parsed = Number.parseInt(arg, 10);
				if (!Number.isInteger(parsed) || parsed <= 0) {
					await this.sendCustomMessage(
						{
							customType: "leader-max-turns",
							content: `Invalid /max-turns value: "${arg}". Expected a positive integer.`,
							display: true,
						},
						undefined,
					);
					return;
				}
				this.settingsManager.setLeaderMaxTurns(parsed);
				this._leaderMaxTurns = parsed;
				if (this._leaderTurnsStopped && this._leaderTurnCount < parsed) {
					this._leaderTurnsStopped = false;
				}
				await this.sendCustomMessage(
					{
						customType: "leader-max-turns",
						content: `Leader turn cap set to ${parsed}${this._leaderTurnsStopped ? "" : " (resumed)"}.`,
						display: true,
					},
					undefined,
				);
				return;
			}

			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
				expandedText = this._expandPromptFileMentions(expandedText);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
				const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant && (await this._checkCompaction(lastAssistant, false))) {
				try {
					await this.agent.continue();
					while (await this._handlePostAgentRun()) {
						await this.agent.continue();
					}
				} catch (error) {
					preflightResult?.(false);
					throw error;
				} finally {
					this._flushPendingBashMessages();
				}
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		Effect.runSync(this._epochCoordinator.beginTurn());
		this._turnEpochToken = this._epochCoordinator.captureToken();

		// Pre-send payload guard: proactively compact if the outgoing request would
		// exceed the context window. Catches providers that don't return a detectable
		// overflow error (silent growth, as in mrkkpimo).
		if (this.model && this.settingsManager.getCompactionEnabled() && Array.isArray(messages)) {
			const outgoingTokens = estimateMessagesTokens(this.agent.state.messages) + estimateMessagesTokens(messages);
			const softCap = computeSoftCap(this.model.contextWindow);
			const hardCap = this.model.contextWindow - OUTPUT_TOKEN_RESERVE;
			if (outgoingTokens > hardCap || outgoingTokens > softCap * 1.1) {
				const lastAssistant = this._findLastAssistantMessage();
				if (lastAssistant && (await this._checkCompaction(lastAssistant, false))) {
					// Compaction ran and rebuilt this.agent.state.messages. Rebuild the
					// local `messages` array from the compacted history plus the new
					// user message(s) so we don't send a stale oversized payload.
					messages = this.agent.state.messages.concat(messages.filter((m) => m.role === "user"));
				}
			}
		}

		// Wire up session ID on scratchpad for artifact metadata tracing
		this._scratchpad.setSessionId(this.sessionId);

		// Auto-snapshot: capture git tree state before the agent turn
		const experimental = this.settingsManager.getExperimentalSettings();
		if (experimental.autoSnapshot && isGitRepo(this._cwd)) {
			const messageId = createCheckpointId("turn-start");
			const treeOID = createSnapshot(this._cwd, this.sessionId, messageId);
			if (!treeOID) {
				// Snapshot creation failed; continue without blocking
			}
		}

		// Per-turn git state refresh (G-7.2): keep branch/status/commits current
		// and surface them in the system prompt every turn for all prompt variants.
		this._gitState = collectGitState(this._cwd);
		const gitBlock = this._formatGitStateBlock();
		if (gitBlock) {
			this.agent.state.systemPrompt = `${this.agent.state.systemPrompt}\n\n${gitBlock}`;
		}

		await this._runAgentPrompt(messages);

		if (experimental.autoSnapshot && isGitRepo(this._cwd)) {
			createSnapshot(this._cwd, this.sessionId, createCheckpointId("turn-end"));
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			this._emit({
				type: "skill_activated",
				skillName: skill.name,
				skillPath: skill.filePath,
				hasArgs: args.length > 0,
			});
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	private _expandPromptFileMentions(text: string): string {
		if (!text.includes("@")) return text;
		const result = expandAtFileIncludes(text, join(this._cwd, ".piki-prompt.md"));
		for (const warning of result.warnings) {
			this.emitRuntimeEvent({
				type: "prompt.file_include_warning",
				payload: { warning },
			});
		}
		return result.content;
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
		},
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		Effect.runSync(this._epochCoordinator.interrupt("abort"));
		// S8: mirror mag alpha22 `interruptToStep` by recording the interruption as
		// a session entry so the ATIF alpha22 export reproduces the interrupt step.
		// A single-session abort is not a full kill, so allKilled = false.
		this.sessionManager.appendInterrupt(this.sessionId, false);
		this._turnEpochToken = undefined;
		this.abortRetry();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		// The prompt profile is derived from the active model's lineage, so a
		// model switch can change which prompt style renders. Rebuild the base
		// system prompt from the now-current model before the next turn.
		this._rebuildBaseSystemPromptFromModel();
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Get the live per-role model overrides (roleId -> `${provider}/${id}`).
	 * Read fresh so in-session changes apply to spawned workers immediately.
	 */
	getRoleModelOverrides(): Record<string, string> {
		return { ...this._roleModelOverrides };
	}

	/**
	 * Set a per-role model override. Validates the role exists and that the
	 * model has configured auth. Persists to global settings so it survives reload.
	 */
	setRoleModel(role: string, model: Model<any>): void {
		if (!ROLE_DEFINITIONS[role]) {
			throw new Error(`Unknown role: ${role}`);
		}
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}
		this._roleModelOverrides[role] = `${model.provider}/${model.id}`;
		this.settingsManager.setRoleModels({ ...this._roleModelOverrides });
	}

	/**
	 * Reset a role's model override back to its default (per-role id / tier fallback).
	 */
	resetRoleModel(role: string): void {
		if (!ROLE_DEFINITIONS[role]) {
			throw new Error(`Unknown role: ${role}`);
		}
		delete this._roleModelOverrides[role];
		this.settingsManager.setRoleModels({ ...this._roleModelOverrides });
	}
	/**
	 * Cycle to next/previous model.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const scopedModels = this._scopedModels.filter((scoped) => this._modelRegistry.hasConfiguredAuth(scoped.model));
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return {
			model: next.model,
			thinkingLevel: this.thinkingLevel,
			isScoped: true,
		};
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return {
			model: nextModel,
			thinkingLevel: this.thinkingLevel,
			isScoped: false,
		};
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		this._disconnectFromAgent();
		await this.abort();
		this._compactionAbortController = this._cancellationScope.create("compaction");
		this._emit({ type: "compaction_start", reason: "manual" });

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings, this.model.contextWindow);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFn,
					env,
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				details,
			};
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._cancellationScope.clear("compaction", this._compactionAbortController);
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
		}
	}

	private _getLatestCompactionTimestamp(): number {
		const latestCompaction = getLatestCompactionEntry(this.sessionManager.getEntries());
		return latestCompaction ? new Date(latestCompaction.timestamp).getTime() : 0;
	}

	private _findLastSuccessfulUsageSince(timestamp: number, beforeTimestamp: number): number | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			const assistant = message as AssistantMessage;
			if (assistant.timestamp >= beforeTimestamp) continue;
			if (assistant.timestamp <= timestamp) break;
			if (assistant.stopReason === "error" || assistant.stopReason === "aborted") continue;
			if (assistant.usage.totalTokens > 0) {
				return assistant.usage.totalTokens;
			}
		}
		return undefined;
	}

	/**
	 * Compatibility shim for auto-compaction used by the existing characterization tests.
	 * This preserves threshold/overflow compaction semantics without forcing callers to
	 * go through the manual compact() path.
	 */
	private async _runAutoCompaction(reason: "threshold" | "overflow", willRetry: boolean): Promise<boolean> {
		this._compactionAbortController = this._cancellationScope.create("compaction");
		let started = false;
		let ended = false;
		const timeout = setTimeout(() => this.abortCompaction(), COMPACTION_TIMEOUT_MS);
		try {
			if (!this.model) {
				return false;
			}

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();
			if (settings.continuationCharThreshold === 100_000) {
				settings.continuationCharThreshold = computeContinuationCharThreshold(this.model.contextWindow);
			}
			const preparation = prepareCompaction(pathEntries, settings, this.model.contextWindow);
			if (!preparation) {
				return false;
			}

			this._emit({ type: "compaction_start", reason });
			started = true;

			const { apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;
			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					return false;
				}
				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;
			if (extensionCompaction) {
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				let result: CompactionResult | null = null;
				for (let attempt = 0; attempt < COMPACTION_MAX_RETRIES; attempt++) {
					result = await this._runCompactionTurn(
						preparation,
						apiKey,
						headers,
						env,
						this._compactionAbortController.signal,
					);
					if (result) break;
				}
				if (!result) {
					const recovered = await this._extractiveTailKeepFallback(reason);
					if (recovered) {
						this._emit({
							type: "compaction_end",
							reason,
							result: undefined,
							aborted: false,
							willRetry: false,
						});
						ended = true;
						return this.agent.hasQueuedMessages();
					}
					throw new Error("Auto-compaction failed: model did not call compact and fallback unavailable");
				}
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);
			const savedCompactionEntry = newEntries.find(
				(entry) => entry.type === "compaction" && entry.summary === summary,
			) as CompactionEntry | undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				details,
			};
			this._emit({
				type: "compaction_end",
				reason,
				result,
				aborted: false,
				willRetry,
			});
			ended = true;

			if (willRetry) {
				const lastMessage = this.agent.state.messages[this.agent.state.messages.length - 1];
				if (lastMessage?.role === "assistant" && (lastMessage as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = this.agent.state.messages.slice(0, -1);
				}
				return true;
			}

			return this.agent.hasQueuedMessages();
		} catch (error) {
			if (started) {
				const message = error instanceof Error ? error.message : String(error);
				// Graceful degradation: alpha22 falls back to tail-keeping rather than
				// throwing when summarization fails. Attempt the extractive fallback;
				// only emit a hard failure if even that cannot run. The fallback itself
				// does NOT emit the terminal event — this block owns exactly one
				// compaction_end per started compaction (single start -> single end).
				const recovered = await this._extractiveTailKeepFallback(reason);
				if (recovered) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: false,
						willRetry: false,
					});
					ended = true;
					return this.agent.hasQueuedMessages();
				}
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						reason === "overflow"
							? `Context overflow recovery failed: ${message}`
							: `Auto-compaction failed: ${message}`,
				});
				ended = true;
			}
			return false;
		} finally {
			clearTimeout(timeout);
			this._cancellationScope.clear("compaction", this._compactionAbortController);
			this._compactionAbortController = undefined;
			// Defensive: never leave a started compaction without a terminal event.
			if (started && !ended) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
					errorMessage: "Auto-compaction terminated without completion (defensive guard).",
				});
			}
		}
	}

	private async _runCompactionTurn(
		preparation: CompactionPreparation,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		env: Record<string, string> | undefined,
		signal: AbortSignal,
	): Promise<CompactionResult | null> {
		const model = this.model;
		if (!model) return null;

		const messages = convertToLlm(this.agent.state.messages);
		messages.push({
			role: "user",
			content: [{ type: "text", text: COMPACTION_REFLECTION_PROMPT }],
			timestamp: Date.now(),
		});

		const compactDefinition = this.getToolDefinition("compact");
		if (!compactDefinition) {
			throw new Error("Compaction tool is not registered");
		}

		const context: Context = {
			systemPrompt: this.agent.state.systemPrompt,
			messages,
			tools: [
				{
					name: compactDefinition.name,
					description: compactDefinition.description,
					parameters: compactDefinition.parameters,
				},
			],
		};
		const stream = await this.agent.streamFn(model, context, {
			apiKey,
			headers,
			env,
			reasoning: this.thinkingLevel === "off" ? undefined : this.thinkingLevel,
			signal,
		});

		for await (const _event of stream) {
			if (signal.aborted) {
				throw new Error("Compaction cancelled");
			}
		}
		const response = await stream.result();
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(`Compaction turn failed: ${response.errorMessage || response.stopReason}`);
		}

		const toolCall = response.content.find(
			(content): content is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
				content.type === "toolCall" && content.name === "compact",
		);
		if (!toolCall) return null;

		const args = toolCall.arguments as {
			summary?: unknown;
			reflection?: unknown;
			files?: unknown;
		};
		if (typeof args.summary !== "string" || typeof args.reflection !== "string") {
			return null;
		}

		const requestedFiles = Array.isArray(args.files)
			? args.files.filter((file): file is string => typeof file === "string").slice(0, COMPACT_MAX_FILES)
			: [];
		const preservedFiles: Array<{ path: string; content: string }> = [];
		// alpha22 budget: maxPayloadTokens = max(4000, softCap - systemPromptTokens
		// - sessionContextTokens - keptTailTokens - margin), charBudget = *3.
		// keptTailTokens is the tokens of the recent messages that survive
		// compaction (tokensBefore minus the messages being summarized).
		const softCap = Math.floor(computeSoftCap(model.contextWindow));
		const systemPromptTokens = Math.ceil((this.agent.state.systemPrompt?.length ?? 0) / 4);
		const sessionContextTokens = this.agent.state.messages[0] ? estimateTokens(this.agent.state.messages[0]!) : 0;
		const keptTailTokens = Math.max(
			0,
			preparation.tokensBefore - estimateContextTokens(preparation.messagesToSummarize).tokens,
		);
		const maxPayloadTokens = Math.max(
			4000,
			softCap - systemPromptTokens - sessionContextTokens - keptTailTokens - 2000,
		);
		const charBudget = maxPayloadTokens * CHARS_PER_TOKEN_LOWER;
		let remainingChars = Math.max(0, charBudget - args.summary.length - args.reflection.length);
		for (const filePath of requestedFiles) {
			if (signal.aborted || remainingChars <= 0) break;
			try {
				const contents = readFileSync(resolvePath(filePath, this._cwd), "utf-8");
				const limit = Math.min(COMPACT_MAX_FILE_CHARS, remainingChars);
				preservedFiles.push({
					path: filePath,
					content: contents.length <= limit ? contents : `[${contents.length} chars — read file as needed]`,
				});
				remainingChars -= Math.min(contents.length, limit);
			} catch {
				// Alpha22 logs and skips files that cannot be read.
			}
		}

		const details: CompactionDetails & { reflection: string } = {
			readFiles: requestedFiles,
			modifiedFiles: [],
			files: preservedFiles,
			reflection: args.reflection,
		};
		return {
			summary: args.summary,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details,
		};
	}

	/**
	 * Extractive tail-keep fallback (alpha22 `COMPACTION_FALLBACK_KEEP_RATIO=0.25`):
	 * when LLM summarization fails, keep the initial task message plus the most
	 * recent entries whose accumulated tokens fit within `softCap * 0.25`, walking
	 * the raw session entries backwards from the tail. Mirrors alpha22 degrading
	 * to token-budget tail-keeping rather than throwing.
	 *
	 * Unlike the prior count-fraction implementation, this matches mag's
	 * token-budget semantics (mag:114393): `fallbackBudget = softCap * 0.25`,
	 * accumulate `estimatedTokens` over raw entries, no synthetic note injected.
	 *
	 * Callers own emission of the terminal `compaction_end` event so that a single
	 * `compaction_start` always maps to exactly one `compaction_end`.
	 */
	private async _extractiveTailKeepFallback(_reason: "threshold" | "overflow"): Promise<boolean> {
		try {
			const pathEntries = this.sessionManager.getBranch();
			if (pathEntries.length === 0) return false;

			const model = this.model;
			const softCap = model ? Math.floor(computeSoftCap(model.contextWindow)) : 0;
			const fallbackBudget = softCap > 0 ? softCap * COMPACTION_FALLBACK_KEEP_RATIO : 0;

			// Per-entry token estimate. Message entries use the shared estimator;
			// system/bookkeeping entries (compaction, branch_summary, label, etc.)
			// carry negligible tokens, approximated as a small constant.
			const entryTokens = (entry: SessionEntry): number => {
				if (entry.type === "message") return estimateTokens(entry.message);
				return Math.ceil(64 / 4);
			};

			// mag keeps the leading context entry (system prompt in mag; the initial
			// task message here) outside the budget and walks the remaining entries
			// backwards (mag:114393 `fork4.messages.slice(1)`).
			const allNonSession = pathEntries.slice(1);
			let accumulated = 0;
			let keepFrom = allNonSession.length;
			if (fallbackBudget > 0) {
				for (let i = allNonSession.length - 1; i >= 0; i--) {
					if (accumulated + entryTokens(allNonSession[i]) > fallbackBudget) break;
					accumulated += entryTokens(allNonSession[i]);
					keepFrom = i;
				}
			}

			const leadingEntry = pathEntries[0]!;
			const keptMessages: AgentMessage[] = [];
			if (leadingEntry.type === "message") keptMessages.push(leadingEntry.message);
			for (const entry of allNonSession.slice(keepFrom)) {
				if (entry.type === "message") keptMessages.push(entry.message);
			}
			if (keptMessages.length === 0) return false;

			const firstKeptEntry = allNonSession[keepFrom] ?? leadingEntry;
			this.agent.state.messages = keptMessages;
			this.sessionManager.appendCompaction(
				"[Context compressed: earlier history removed via extractive tail-keep fallback]",
				firstKeptEntry?.id ?? leadingEntry.id,
				estimateMessagesTokens(keptMessages),
				{ fallback: true },
				false,
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Compatibility shim for threshold/overflow compaction checks.
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled || !this.model) {
			return false;
		}
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") {
			return false;
		}

		const latestCompactionTimestamp = this._getLatestCompactionTimestamp();
		if (!skipAbortedCheck && latestCompactionTimestamp >= assistantMessage.timestamp) {
			return false;
		}

		const sameModel = assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;
		if (sameModel && isContextOverflow(assistantMessage, this.model.contextWindow)) {
			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}
			this._overflowRecoveryAttempted = true;
			return this._runAutoCompaction("overflow", assistantMessage.stopReason === "error");
		}

		if (assistantMessage.stopReason !== "error") {
			this._overflowRecoveryAttempted = false;
		}

		if (
			sameModel &&
			assistantMessage.stopReason !== "error" &&
			assistantMessage.usage.totalTokens > this.model.contextWindow
		) {
			return this._runAutoCompaction("overflow", false);
		}

		let usageTokens = assistantMessage.usage.totalTokens;
		if (assistantMessage.stopReason === "error") {
			const lastSuccessfulUsage = this._findLastSuccessfulUsageSince(
				latestCompactionTimestamp,
				assistantMessage.timestamp,
			);
			if (lastSuccessfulUsage === undefined) {
				return false;
			}
			usageTokens = lastSuccessfulUsage;
		}

		let continuationCharThreshold = settings.continuationCharThreshold ?? 100000;
		if (continuationCharThreshold === 100_000) {
			continuationCharThreshold = computeContinuationCharThreshold(this.model.contextWindow);
		}
		const contextChars = estimateContextChars(this.agent.state.messages);
		// Use a running token estimate (anchored last usage + char-estimated trailing
		// delta) for the normal threshold check so compaction fires mid-growth between
		// provider usage points, matching alpha22's computeTokenEstimate. The
		// error-recovery path still relies on real provider usage (usageTokens below).
		const thresholdTokens =
			assistantMessage.stopReason === "error"
				? usageTokens
				: estimateContextTokens(this.agent.state.messages).tokens;
		if (
			!(continuationCharThreshold > 0 && contextChars >= continuationCharThreshold) &&
			!shouldCompact(thresholdTokens, this.model.contextWindow, settings)
		) {
			return false;
		}

		return this._runAutoCompaction("threshold", false);
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._cancellationScope.abort("compaction");
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._cancellationScope.abort("branchSummary");
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: {
			source: string;
			scope: "temporary";
			origin: "top-level";
			baseDir?: string;
		};
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
		// A refresh keeps provider+id, so the lineage/profile cannot change; the
		// rebuild helper no-ops in that case. Kept for safety and symmetry with
		// setModel/cycleModel.
		this._rebuildBaseSystemPromptFromModel();
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const builtinsAvailable = this._baseToolDefinitions.size > 0;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);
		const isAllowedBuiltinAddon = (name: string): boolean =>
			builtinsAvailable && allowedToolNames !== undefined && allowedToolNames.has(name) && isAllowedTool(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, {
					source: "sdk",
				}),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, {
							source: "builtin",
						}),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;

		// Register restore_snapshot and checkpoint_changes tools when auto-snapshot is enabled
		const experimental = this.settingsManager?.getExperimentalSettings();
		this._snapshotEnabled = experimental?.autoSnapshot ?? false;
		if (this._snapshotEnabled && isAllowedBuiltinAddon("restore_snapshot")) {
			const snapshotToolDef = createRestoreSnapshotToolDefinition(this._cwd, this.sessionId);
			const snapshotToolEntry: ToolDefinitionEntry = {
				definition: snapshotToolDef,
				sourceInfo: createSyntheticSourceInfo("<builtin:restore_snapshot>", {
					source: "builtin",
				}),
			};
			this._toolDefinitions.set("restore_snapshot", snapshotToolEntry);
		}
		if (this._snapshotEnabled && isAllowedBuiltinAddon("checkpoint_changes")) {
			const checkpointToolDef = createCheckpointChangesToolDefinition(this._cwd, this.sessionId);
			const checkpointToolEntry: ToolDefinitionEntry = {
				definition: checkpointToolDef,
				sourceInfo: createSyntheticSourceInfo("<builtin:checkpoint_changes>", {
					source: "builtin",
				}),
			};
			this._toolDefinitions.set("checkpoint_changes", checkpointToolEntry);
		}

		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.filter(({ definition }) => !definition.hidden)
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}

		// Register restore_snapshot and checkpoint_changes agent tools when auto-snapshot is enabled
		if (this._snapshotEnabled && isAllowedBuiltinAddon("restore_snapshot")) {
			const snapshotEntry = this._toolDefinitions.get("restore_snapshot");
			if (snapshotEntry) {
				const wrappedSnapshotTool = wrapToolDefinition(snapshotEntry.definition, () => runner.createContext());
				toolRegistry.set("restore_snapshot", wrappedSnapshotTool);
			}
		}
		if (this._snapshotEnabled && isAllowedBuiltinAddon("checkpoint_changes")) {
			const checkpointEntry = this._toolDefinitions.get("checkpoint_changes");
			if (checkpointEntry) {
				const wrappedCheckpointTool = wrapToolDefinition(checkpointEntry.definition, () => runner.createContext());
				toolRegistry.set("checkpoint_changes", wrappedCheckpointTool);
			}
		}
		// Register scratchpad tools (always available).
		// Skip if an extension already registered a tool with the same name, so
		// extensions can override builtins by name.
		if (builtinsAvailable && isAllowedTool("scratchpad_save") && !toolRegistry.has("scratchpad_save")) {
			const saveDef = createScratchpadSaveToolDefinition(this._scratchpad);
			const saveEntry: ToolDefinitionEntry = {
				definition: saveDef,
				sourceInfo: createSyntheticSourceInfo("<builtin:scratchpad_save>", {
					source: "builtin",
				}),
			};
			this._toolDefinitions.set("scratchpad_save", saveEntry);
			toolRegistry.set(
				"scratchpad_save",
				wrapToolDefinition(saveDef, () => runner.createContext()),
			);
		}
		if (builtinsAvailable && isAllowedTool("scratchpad_load") && !toolRegistry.has("scratchpad_load")) {
			const loadDef = createScratchpadLoadToolDefinition(this._scratchpad);
			const loadEntry: ToolDefinitionEntry = {
				definition: loadDef,
				sourceInfo: createSyntheticSourceInfo("<builtin:scratchpad_load>", {
					source: "builtin",
				}),
			};
			this._toolDefinitions.set("scratchpad_load", loadEntry);
			toolRegistry.set(
				"scratchpad_load",
				wrapToolDefinition(loadDef, () => runner.createContext()),
			);
		}
		if (builtinsAvailable && isAllowedTool("web_search") && !toolRegistry.has("web_search")) {
			const webSearchDef = createWebSearchToolDefinition();
			this._toolDefinitions.set("web_search", {
				definition: webSearchDef,
				sourceInfo: createSyntheticSourceInfo("<builtin:web_search>", {
					source: "builtin",
				}),
			});
			toolRegistry.set(
				"web_search",
				wrapToolDefinition(webSearchDef, () => runner.createContext()),
			);
		}
		if (builtinsAvailable && isAllowedTool("web_fetch") && !toolRegistry.has("web_fetch")) {
			const webFetchDef = createWebFetchToolDefinition();
			this._toolDefinitions.set("web_fetch", {
				definition: webFetchDef,
				sourceInfo: createSyntheticSourceInfo("<builtin:web_fetch>", {
					source: "builtin",
				}),
			});
			toolRegistry.set(
				"web_fetch",
				wrapToolDefinition(webFetchDef, () => runner.createContext()),
			);
		}

		// Register role-control tools by default. They are part of the core multi-agent runtime,
		// not optional addons that require a --tools allowlist.
		const roleTools = [
			["spawnWorker", createSpawnWorkerToolDefinition()],
			["killWorker", createKillWorkerToolDefinition()],
			["messageWorker", createMessageWorkerToolDefinition()],
			["createTask", createCreateTaskToolDefinition()],
			["updateTask", createUpdateTaskToolDefinition()],
			["finishGoal", createFinishGoalToolDefinition()],
			["reassignWorker", createReassignWorkerToolDefinition()],
			["messageAdvisor", createMessageAdvisorToolDefinition()],
		] as const;
		for (const [toolName, toolDef] of roleTools) {
			if (!builtinsAvailable || !isAllowedTool(toolName)) continue;
			this._toolDefinitions.set(toolName, {
				definition: toolDef,
				sourceInfo: createSyntheticSourceInfo(`<builtin:${toolName}>`, {
					source: "builtin",
				}),
			});
			toolRegistry.set(
				toolName,
				wrapToolDefinition(toolDef, () => runner.createContext()),
			);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (
			this._snapshotEnabled &&
			isAllowedTool("restore_snapshot") &&
			!nextActiveToolNames.includes("restore_snapshot")
		) {
			nextActiveToolNames.push("restore_snapshot");
		}
		if (
			this._snapshotEnabled &&
			isAllowedTool("checkpoint_changes") &&
			!nextActiveToolNames.includes("checkpoint_changes")
		) {
			nextActiveToolNames.push("checkpoint_changes");
		}

		for (const name of [
			"spawnWorker",
			"killWorker",
			"messageWorker",
			"createTask",
			"updateTask",
			"finishGoal",
			"reassignWorker",
			"messageAdvisor",
		]) {
			if (
				builtinsAvailable &&
				isAllowedTool(name) &&
				this._toolRegistry.has(name) &&
				!nextActiveToolNames.includes(name)
			) {
				nextActiveToolNames.push(name);
			}
		}

		// Scratchpad and web tools are core tools.
		for (const name of ["scratchpad_save", "scratchpad_load", "web_search", "web_fetch"]) {
			if (isAllowedTool(name) && !nextActiveToolNames.includes(name)) {
				nextActiveToolNames.push(name);
			}
		}

		if (allowedToolNames && this._autoActivateAllowedTools) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					scratchpadPath: this._scratchpad.getRootDir(),
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath, scratchpadPath: this._scratchpad.getRootDir() },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		this._emit({ type: "session_shutdown", reason: "reload" });
		await emitSessionShutdownEvent(this._extensionRunner, {
			type: "session_shutdown",
			reason: "reload",
		});
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({
				type: "session_start",
				reason: "reload",
			});
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Detect a non-retryable provider quota/usage-limit error.
	 * Quota-exhausted errors will not resolve by retrying with the same credentials.
	 */
	private _isNonRetryableProviderLimitError(errorMessage: string): boolean {
		return classifyError(errorMessage).category === "quota";
	}

	/**
	 * Check if an error is retryable using the Amp-style error classifier.
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		const decision = decideAssistantCommit({
			message,
			contextWindow: this.model?.contextWindow ?? 0,
			isNonRetryableProviderLimitError: (errorMessage) => this._isNonRetryableProviderLimitError(errorMessage),
			isProviderApiKeyRetryable: (provider, category) =>
				this._modelRegistry.shouldRetryProviderApiKeyFailure(provider, category),
			classifyError,
		});
		return decision.retryable;
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const errorMessage = message.errorMessage || "Unknown error";
		const classification = classifyError(errorMessage);
		// Tool validation errors retry immediately (no backoff)
		const isToolValidation = errorMessage.startsWith("tool_validation:");
		const serverDelayMs = isToolValidation ? 0 : classification.retryDelayMs;
		const delayMs = isToolValidation
			? 0
			: computeJitteredDelay(this._retryAttempt - 1, settings.baseDelayMs, 30000, serverDelayMs);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage,
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = this._cancellationScope.create("retry");
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._cancellationScope.clear("retry", this._retryAbortController);
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._cancellationScope.abort("retry");
	}

	/**
	 * Abort the in-flight LLM stream for mid-stream tool-call validation failure.
	 * Sets a pending override so the aborted assistant message is treated as a
	 * retryable tool_validation error by _isRetryableError / _prepareRetry.
	 * @param _reason - abort reason tag (currently always "tool_validation")
	 * @param feedback - formatted corrective feedback for the agent's next turn
	 */
	abortCurrentStream(_reason: string, feedback: string): void {
		this._pendingToolValidationFeedback = `tool_validation: ${feedback}`;
		this.agent.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		this._bashAbortController = this._cancellationScope.create("bash");

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: this._bashAbortController.signal,
					scratchpadPath: this._scratchpad.getRootDir(),
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._cancellationScope.clear("bash", this._bashAbortController);
			this._bashAbortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			startedAt: result.startedAt,
			endedAt: result.endedAt,
			durationMs: result.durationMs,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._cancellationScope.abort("bash");
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		} = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = this._cancellationScope.create("branchSummary");

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFn,
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._cancellationScope.clear("branchSummary", this._branchSummaryAbortController);
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				const usage = assistantMsg.usage;
				totalInput += usage.input;
				totalOutput += usage.output;
				totalCacheRead += usage.cacheRead;
				totalCacheWrite += usage.cacheWrite;
				totalCost += usage.cost.total;
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
