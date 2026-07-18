/**
 * WorkerSession - runs an LLM agent loop for a forked worker.
 *
 * Delegates to the full Agent class from @piki/agent-core,
 * matching the leader's AgentSession pattern:
 * - Grammar injection (GBNF for open-weight models)
 * - Structured output injection (provider-native for frontier APIs)
 * - Parallel tool execution with beforeToolCall/afterToolCall hooks
 * - Mid-stream tool argument validation via StreamingFieldParser
 * - Event subscription model for fork visibility
 * - Lightweight compaction via transformContext
 */

import { randomUUID } from "node:crypto";
import {
	type AfterToolCallResult,
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeToolCallResult,
	type StreamFn,
} from "@piki/agent-core";
import type { CacheRetention, ImageContent, Model, TextContent } from "@piki/ai";
import {
	allowUnknownFieldsForStreaming,
	clampThinkingLevel,
	composePayloadHooks,
	createGrammarInjector,
	createStructuredOutputInjector,
	formatCorrectiveFeedback,
	type ModelThinkingLevel,
	StreamingFieldParser,
	typeboxToStreamingSchema,
} from "@piki/ai";
import type { AssistantMessage } from "@piki/ai/compat";
import { KEEP_MESSAGE_RATIO } from "@piki/event-core";
import { Effect } from "effect";
import type { TSchema } from "typebox";
import { EpochInterruptCoordinator } from "./epoch-interrupt-coordinator.ts";
import { ErrorRepeatGuard } from "./error-repeat-guard.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import { checkInputForGuardedPaths, MUTATING_TOOLS } from "./permissions/guarded-paths.ts";
import { evaluatePermission, type PermissionRule } from "./permissions/permission-gate.ts";
import { getRolePolicyRules } from "./permissions/role-policy.ts";
import type { SessionMessageEntry } from "./session-manager.ts";
import { DEFAULT_WORKER_MAX_TURNS } from "./settings-manager.ts";
import { ThinkingGovernor } from "./thinking-governor.ts";
import { setForkContext } from "./worker-executor.ts";

export interface WorkerTool {
	name: string;
	description: string;
	parameters: TSchema;
	hidden?: boolean;
	internal?: boolean;
	prepareArguments?: (args: unknown) => unknown;
	execute: (
		id: string,
		args: unknown,
		signal: AbortSignal | undefined,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	) => Promise<AgentToolResult<unknown>>;
}

export interface WorkerSessionConfig {
	forkId: string;
	agentId: string;
	role: string;
	model: Model<string>;
	systemPrompt: string;
	initialMessage: string;
	tools: WorkerTool[];
	contextLimit: number;
	cwd?: string;
	scratchpadPath?: string;
	maxTurns?: number;
	/** Desired thinking level for the worker; clamped to the model. Defaults to the leader default thinking level. */
	thinkingLevel?: ModelThinkingLevel;
	userRules?: PermissionRule[];
	streamFn?: StreamFn;
	publishEvent?: (type: string, payload: Record<string, unknown>) => Promise<void> | void;
	/** Prompt-cache retention forwarded to the worker's stream function. */
	cacheRetention?: CacheRetention;
	onFinished: (result: { text: string; forkId: string; agentId: string; stopReason?: string }) => void;
	onError: (error: { error: string; forkId: string; agentId: string; partialResult?: string }) => void;
	/** Shared ref to the leader's ExtensionRunner so worker tool calls fire the same extension hooks. */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Per-tool execution timeout resolver, shared from the leader's SettingsManager. */
	getToolTimeoutMs?: (toolName: string) => number | undefined;
	/** Optional live project-context provider; when given, the leading context
	 * block of the worker's system prompt is refreshed each turn so the worker
	 * sees current git/file state (mirrors AgentSession._maybeReloadContextFiles). */
	getProjectContext?: () => string;
	/** When true, forbid/mass-destructive shell classification and destructive
	 * built-in rules are allowed (alpha22 --disable-shell-safeguards). */
	disableShellSafeguards?: boolean;
	/** When true, role-policy out-of-cwd write rules are skipped (alpha22
	 * --disable-cwd-safeguards). Worker-only; the leader uses a separate
	 * guarded-path mechanism. */
	disableCwdSafeguards?: boolean;
	/** Capture callback: every materialized fork entry (initial user task step,
	 * assistant turns, tool results) is handed to this callback stamped with its
	 * forkId so the executor can build per-fork ATIF subagent trajectories. */
	onForkEntry?: (entry: SessionMessageEntry) => void;
}

/** Adapt WorkerTool → AgentTool (WorkerTool is a structural subset). */
function toAgentTool(tool: WorkerTool): AgentTool {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		execute: tool.execute,
	};
}

const WORKER_MESSAGE_IDS = new WeakMap<object, string>();

function getWorkerMessageId(message: AgentMessage): string {
	if ("id" in message && typeof message.id === "string") {
		return message.id;
	}
	const existing = WORKER_MESSAGE_IDS.get(message);
	if (existing) return existing;
	const id = randomUUID();
	WORKER_MESSAGE_IDS.set(message, id);
	return id;
}

export class WorkerSession {
	private readonly config: WorkerSessionConfig;
	private readonly agent: Agent;
	private readonly unsubscribe: () => void;
	private readonly baseSystemPrompt: string;
	private readonly initialContext: string;
	private readonly errorGuard = new ErrorRepeatGuard({ threshold: 3 });
	private readonly thinkingGovernor: ThinkingGovernor;
	private turnCount = 0;
	private stoppedForMaxTurns = false;
	/** When true, the worker is in its final report turn and tool calls are blocked. */
	private forcedSummaryTurn = false;
	private maxTurnWarningSent = false;
	private loopActive = false;
	private finished = false;
	private killed = false;
	private readonly maxTurns: number;
	private readonly streamingParsers = new Map<string, StreamingFieldParser>();
	private readonly epochCoordinator = new EpochInterruptCoordinator();
	private epochToken: ReturnType<EpochInterruptCoordinator["captureToken"]> | undefined;
	private pendingToolValidationFeedback: string | undefined = undefined;
	private retryAttempt = 0;
	private readonly maxValidationRetries = 3;
	/** Last emitted fork entry id, used to chain parentId for worker ATIF entries. */
	private forkLastId: string | null = null;

	constructor(config: WorkerSessionConfig) {
		this.config = config;
		this.maxTurns = config.maxTurns ?? DEFAULT_WORKER_MAX_TURNS;
		this.baseSystemPrompt = config.systemPrompt;
		this.initialContext = config.getProjectContext?.() ?? "";

		// Unified overthinking mechanism (mirrors AgentSession/ThinkingGovernor for
		// the leader). Workers record thinking deltas and, on exceeding the role's
		// max thought budget, steer corrective feedback and abort the run — same
		// feedback shape alpha22 uses for every role.
		this.thinkingGovernor = new ThinkingGovernor({
			onOverthinking: (info) => {
				this.agent.steer({
					role: "user",
					content: info.feedback,
					timestamp: Date.now(),
				} as AgentMessage);
				this.agent.abort();
			},
		});
		// Convert worker tools to agent tools
		const agentTools = config.tools.map(toAgentTool);

		// Compose grammar + structured output injectors (same as AgentSession)
		const toolSchemas = agentTools.map((t) => t.parameters);
		const onPayload = composePayloadHooks([
			createGrammarInjector(toolSchemas),
			createStructuredOutputInjector(toolSchemas),
		]);

		// Create the Agent with initial state
		this.agent = new Agent({
			initialState: {
				systemPrompt: this.buildSystemPrompt(),
				model: config.model,
				thinkingLevel: config.model.reasoning
					? (clampThinkingLevel(config.model, config.thinkingLevel ?? "off") as ModelThinkingLevel)
					: "off",
				tools: agentTools,
				messages: [
					{
						role: "user",
						content: config.initialMessage,
						timestamp: Date.now(),
					} as AgentMessage,
				],
			},
			onPayload,
			streamFn: config.streamFn,
			cacheRetention: config.cacheRetention,
			toolExecution: "parallel",
			toolTimeout: config.getToolTimeoutMs,
			transformContext: async (messages, signal) => this.compactContext(messages, signal),
			prepareNextTurn: () => {
				// Refresh the leading context block of the system prompt so the
				// worker observes current git/file state each turn (parity with the
				// leader's per-edit context reload).
				this.agent.state.systemPrompt = this.buildSystemPrompt();
				Effect.runSync(this.epochCoordinator.beginTurn());
				this.epochToken = this.epochCoordinator.captureToken();
				return undefined;
			},
		});

		// Wire the epoch staleness check so an assistant message mid-stream at
		// kill time is dropped instead of committed (mirrors AgentSession).
		this.agent.checkEpoch = () => {
			const token = this.epochToken;
			if (!token) return true;
			return this.epochCoordinator.isTokenCurrent(token);
		};

		// Wire beforeToolCall: permission gate + guarded paths
		this.agent.beforeToolCall = async (ctx, signal) =>
			this.checkPermissions(ctx.toolCall.name, ctx.toolCall.id, ctx.args as Record<string, unknown>, signal);

		// Wire afterToolCall: error repeat guard
		this.agent.afterToolCall = async (ctx, _signal) =>
			this.handleAfterToolCall(ctx.toolCall, ctx.args, ctx.result, ctx.isError);

		// Subscribe to agent events and re-publish to fork
		this.unsubscribe = this.agent.subscribe((event, signal) => this.handleAgentEvent(event, signal));

		// Materialize the fork's initial user/task step for ATIF export (alpha22
		// fork.steps begin with the task message). Emitted synchronously in the
		// constructor so it is captured even if the worker never produces a turn.
		const userEntry: SessionMessageEntry = {
			type: "message",
			id: randomUUID(),
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: this.config.initialMessage,
				timestamp: Date.now(),
			},
			forkId: this.config.forkId,
		};
		this.forkLastId = userEntry.id;
		this.config.onForkEntry?.(userEntry);
	}

	deliverMessage(text: string): void {
		this.agent.steer({
			role: "user",
			content: text,
			timestamp: Date.now(),
		} as AgentMessage);
		// If the agent loop has already exited (worker was idle), a bare steer() only
		// enqueues; nobody drains it. Re-enter the loop so the message is processed.
		this.maybeRetrigger();
	}

	kill(): void {
		this.killed = true;
		// Mark current epoch interrupted so a streaming turn's partial assistant
		// message is dropped by the loop's checkEpoch guard.
		this.epochCoordinator.interrupt("killed");
		this.agent.abort();
	}

	async start(): Promise<void> {
		await this.runLoop();
	}

	/** Re-enter the agent loop if it has exited and the worker is still alive. */
	private maybeRetrigger(): void {
		if (this.loopActive || this.finished || this.killed) return;
		void this.runLoop();
	}

	/**
	 * Run the agent until idle, then re-run if messages were steered in after the
	 * loop drained but before we finish. The `loopActive` guard makes this safe to
	 * call from both start() and deliverMessage() without double-entering.
	 */
	private async runLoop(): Promise<void> {
		if (this.loopActive || this.finished || this.killed) return;
		this.loopActive = true;
		try {
			await this.runUntilIdle();
			while (!this.stoppedForMaxTurns && !this.killed && this.agent.hasQueuedMessages()) {
				await this.runUntilIdle();
			}
		} catch (err) {
			this.loopActive = false;
			this.finished = true;
			this.unsubscribe();
			if (!this.killed) {
				this.config.onError({
					error: `Worker session crashed: ${err instanceof Error ? err.message : String(err)}`,
					forkId: this.config.forkId,
					agentId: this.config.agentId,
				});
			}
			return;
		}
		this.loopActive = false;
		// A message may have been steered in between the while-check and flipping
		// loopActive off. Re-enter instead of finishing so it is not lost.
		if (!this.killed && !this.stoppedForMaxTurns && this.agent.hasQueuedMessages()) {
			void this.runLoop();
			return;
		}
		this.finish();
	}

	/** Emit the terminal onFinished/onError result exactly once. */
	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.unsubscribe();

		// Check final state
		const messages = this.agent.state.messages;
		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") as AssistantMessage | undefined;

		if (this.stoppedForMaxTurns) {
			this.config.onFinished({
				text: this.maxTurnsReportText(),
				forkId: this.config.forkId,
				agentId: this.config.agentId,
				stopReason: "max_turns",
			});
			return;
		}

		if (this.killed || this.agent.signal?.aborted || lastAssistant?.stopReason === "aborted") {
			this.config.onError({
				error: "Worker killed",
				forkId: this.config.forkId,
				agentId: this.config.agentId,
				partialResult: this.lastAssistantText(),
			});
			return;
		}

		if (lastAssistant?.stopReason === "error") {
			this.config.onError({
				error: `Worker LLM error: ${lastAssistant.errorMessage ?? "unknown"}`,
				forkId: this.config.forkId,
				agentId: this.config.agentId,
				partialResult: this.lastAssistantText(),
			});
			return;
		}

		// Success or max_turns
		this.config.onFinished({
			text: this.lastAssistantText() ?? this.finishedWithoutTextReport(),
			forkId: this.config.forkId,
			agentId: this.config.agentId,
			stopReason: this.turnCount >= this.maxTurns ? "max_turns" : "finished",
		});
	}

	// ─── Event handling ───

	private async handleAgentEvent(event: AgentEvent, _signal: AbortSignal): Promise<void> {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					await this.publishEvent("message_start", {
						id: getWorkerMessageId(event.message),
						messageId: getWorkerMessageId(event.message),
						messageRole: "assistant",
						destination: { kind: "coordinator" },
					});
				}
				break;

			case "message_update":
				this.handleMessageUpdate(event);
				break;

			case "message_end":
				if (event.message.role === "assistant") {
					const msg = event.message as AssistantMessage;
					if (this.pendingToolValidationFeedback !== undefined) {
						msg.stopReason = "error";
						msg.errorMessage = this.pendingToolValidationFeedback;
						this.pendingToolValidationFeedback = undefined;
					}
					this.checkThinkingBudget(msg);
					const text = this.extractText(msg);
					await this.publishEvent("message_end", {
						id: getWorkerMessageId(event.message),
						messageId: getWorkerMessageId(event.message),
						messageRole: "assistant",
						text,
						stopReason: msg.stopReason,
						destination: { kind: "coordinator" },
					});
					// Materialize the assistant turn as a fork entry for ATIF export.
					const assistantEntry: SessionMessageEntry = {
						type: "message",
						id: getWorkerMessageId(event.message),
						parentId: this.forkLastId,
						timestamp: new Date().toISOString(),
						message: msg,
						forkId: this.config.forkId,
						...(msg.stopReason === "error" ? { llmFailed: true } : {}),
					};
					this.forkLastId = assistantEntry.id;
					this.config.onForkEntry?.(assistantEntry);
				} else if (event.message.role === "toolResult") {
					const tr = event.message as { toolCallId: string; toolName: string; isError: boolean; content: unknown };
					await this.publishEvent("message_end", {
						messageRole: "toolResult",
						toolCallId: tr.toolCallId,
						toolName: tr.toolName,
						text: this.extractToolText(tr.content),
						isError: tr.isError,
					});
					await this.publishEvent("tool_event", {
						toolCallId: tr.toolCallId,
						toolName: tr.toolName,
						result: this.extractToolText(tr.content),
						status: tr.isError ? "error" : "completed",
					});
					// Materialize the tool result as a fork entry for ATIF export.
					const toolResultEntry: SessionMessageEntry = {
						type: "message",
						id: `tr-${tr.toolCallId ?? randomUUID()}`,
						parentId: this.forkLastId,
						timestamp: new Date().toISOString(),
						message: {
							role: "toolResult",
							toolCallId: tr.toolCallId,
							toolName: tr.toolName,
							content: tr.content as never,
							isError: tr.isError,
						} as unknown as AssistantMessage,
						forkId: this.config.forkId,
					};
					this.forkLastId = toolResultEntry.id;
					this.config.onForkEntry?.(toolResultEntry);
				}
				break;

			case "tool_execution_start":
				await this.publishEvent("tool_event", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					status: "started",
				});
				break;

			case "tool_execution_update": {
				const text = this.extractToolUpdateText(event.partialResult);
				if (text) {
					await this.publishEvent("tool_event", {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: text,
						status: "updated",
					});
				}
				break;
			}

			case "turn_end":
				this.turnCount++;
				if (this.turnCount >= this.maxTurns) {
					this.stoppedForMaxTurns = true;
					this.agent.abort();
				} else if (this.turnCount === this.maxTurns - 1) {
					// Final report turn: block further tool calls so the worker
					// produces its text report instead of starting new exploration.
					this.forcedSummaryTurn = true;
					this.agent.steer({
						role: "user",
						content:
							"[System: This is your final report turn. Do not call any more tools. Produce your concise final report now with: outcome, evidence gathered, commands/files checked, verification status, and remaining gaps.]",
						timestamp: Date.now(),
					} as AgentMessage);
				} else if (!this.maxTurnWarningSent && this.turnCount >= this.maxTurns - 3) {
					this.maxTurnWarningSent = true;
					this.agent.steer({
						role: "user",
						content:
							"[System: You are near the worker turn limit. Stop starting new exploration. Return a concise final report now with: outcome, evidence gathered, commands/files checked, verification status, and remaining gaps. If incomplete, say exactly what remains instead of continuing.]",
						timestamp: Date.now(),
					} as AgentMessage);
				}
				break;

			case "agent_end":
				this.streamingParsers.clear();
				// Reset the overthinking governor between runs/retries so the
				// role's thought budget is measured per-run, not cumulatively.
				this.thinkingGovernor.reset(this.config.role);
				// start() await resolves after this
				break;
		}
	}

	private async runUntilIdle(): Promise<void> {
		await this.agent.continue();

		while (this.shouldRetryToolValidation()) {
			const feedback = this.consumeToolValidationFeedback();
			this.removeLastAssistantMessage();
			this.agent.steer({
				role: "user",
				content: feedback,
				timestamp: Date.now(),
			} as AgentMessage);
			await this.publishEvent("worker_retry", {
				reason: "tool_validation",
				attempt: this.retryAttempt,
				maxAttempts: this.maxValidationRetries,
			});
			await this.agent.continue();
		}

		if (this.retryAttempt > 0) {
			this.retryAttempt = 0;
		}
	}

	private handleMessageUpdate(event: Extract<AgentEvent, { type: "message_update" }>): void {
		const update = event.assistantMessageEvent as {
			type?: string;
			delta?: string;
			contentIndex?: number;
		};
		if (update.type === "toolcall_delta" && update.delta) {
			this.handleToolCallDelta(event, update);
		}
		if (update.type === "thinking_delta" && update.delta) {
			// Feed incremental thinking into the unified overthinking governor
			// (mirrors the leader's session-orchestrator recordDelta).
			if (this.thinkingGovernor.recordDelta(this.config.role, update.delta)) {
				// onOverthinking already steered feedback + aborted the agent.
			}
		}
		if (update.type === "toolcall_end") {
			const ended = event.assistantMessageEvent as { toolCall?: { id?: string } };
			if (ended.toolCall?.id) {
				this.streamingParsers.delete(ended.toolCall.id);
			}
		}
		const text = update.delta ?? "";
		if (text) {
			void this.publishEvent("message_chunk", {
				id: getWorkerMessageId(event.message),
				messageId: getWorkerMessageId(event.message),
				text,
				destination: { kind: "coordinator" },
			}).catch(() => {});
		}
	}

	private handleToolCallDelta(
		event: Extract<AgentEvent, { type: "message_update" }>,
		update: { delta?: string; contentIndex?: number },
	): void {
		const message = event.message as { content?: Array<{ type: string; id?: string; name?: string }> };
		const contentIndex = update.contentIndex ?? 0;
		const content = message.content?.[contentIndex];
		if (!content || content.type !== "toolCall" || !content.id || !content.name) return;

		let parser = this.streamingParsers.get(content.id);
		if (!parser) {
			const tool = this.agent.state.tools.find((entry) => entry.name === content.name);
			if (!tool) return;
			try {
				let schema = typeboxToStreamingSchema(tool.parameters);
				if (typeof tool.prepareArguments === "function") {
					schema = allowUnknownFieldsForStreaming(schema);
				}
				parser = new StreamingFieldParser(schema);
			} catch {
				return;
			}
			this.streamingParsers.set(content.id, parser);
		}

		parser.push(update.delta ?? "");

		if (!parser.valid) {
			const feedback = formatCorrectiveFeedback(parser.getValidationState());
			this.pendingToolValidationFeedback = `tool_validation: ${feedback}`;
			this.agent.abort();
			void this.publishEvent("tool_validation_failed", {
				toolName: content.name,
				toolCallId: content.id,
				errors: [parser.validationIssue ?? "Unknown validation error"],
			}).catch(() => {});
			this.streamingParsers.clear();
		}
	}

	private shouldRetryToolValidation(): boolean {
		if (this.stoppedForMaxTurns) {
			return false;
		}
		const message = this.lastAssistantMessage();
		if (message?.stopReason !== "error" || !message.errorMessage?.startsWith("tool_validation:")) {
			return false;
		}
		this.retryAttempt++;
		return this.retryAttempt <= this.maxValidationRetries;
	}

	private consumeToolValidationFeedback(): string {
		const message = this.lastAssistantMessage();
		return (
			message?.errorMessage?.slice("tool_validation:".length).trim() ||
			"Your previous tool call had invalid arguments. Try again with arguments that match the tool schema."
		);
	}

	private removeLastAssistantMessage(): void {
		const messages = this.agent.state.messages;
		if (messages[messages.length - 1]?.role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}
	}

	// ─── Permission gate ───

	private async checkPermissions(
		toolName: string,
		_toolCallId: string,
		args: Record<string, unknown>,
		_signal?: AbortSignal,
	): Promise<BeforeToolCallResult | undefined> {
		// During the final report turn, block all tool calls so the worker emits
		// its text report instead of starting new exploration.
		if (this.forcedSummaryTurn) {
			return {
				block: true,
				reason: "Final report turn in progress. Tool calls are blocked. Produce your text report now.",
			};
		}

		// Set fork context for detached process tracking
		setForkContext(this.config.forkId);

		const permissionDecision = evaluatePermission(toolName, args, {
			interactive: false,
			context: "subagent",
			knownTools: this.config.tools.map((t) => t.name),
			userRules: this.config.userRules ?? [],
			roleId: this.config.role,
			rolePolicyRules: getRolePolicyRules(this.config.role, this.config.cwd, this.config.scratchpadPath, {
				disableCwdSafeguards: this.config.disableCwdSafeguards,
				disableShellSafeguards: this.config.disableShellSafeguards,
			}),
			disableShellSafeguards: this.config.disableShellSafeguards,
			cwd: this.config.cwd,
			scratchpadPath: this.config.scratchpadPath,
		});

		if (!permissionDecision.permitted) {
			return {
				block: true,
				reason: `Permission denied: ${permissionDecision.reason ?? `Tool ${toolName} is not permitted in worker context`}`,
			};
		}

		// Guarded path check for mutating tools
		if (MUTATING_TOOLS.has(toolName)) {
			const guardedPathResult = checkInputForGuardedPaths(args);
			if (guardedPathResult) {
				return {
					block: true,
					reason: `[Permission Gate] Tool \`${toolName}\` blocked on guarded path \`${guardedPathResult.path}\``,
				};
			}
		}

		// Extension tool_call hooks (mirrors AgentSession.beforeToolCall ordering:
		// after permission + guarded-path checks). The leader's runner is shared via
		// the ref, so all loaded extensions fire here too. emitToolCall mutates
		// args in place via the `modify` action, propagating to execution.
		const runnerRef = this.config.extensionRunnerRef;
		const runner = runnerRef?.current;
		if (runner && (runner.hasHandlers("tool_call") || runner.hasHandlers("before_tool_call"))) {
			const toolCallResult = await runner.emitToolCall({
				type: "tool_call",
				toolName,
				toolCallId: _toolCallId,
				input: args,
			});
			// Middleware synthesize: return immediate result to bypass execution.
			if (toolCallResult?.synthesizeResult) {
				return {
					immediateResult: toolCallResult.synthesizeResult,
					immediateResultIsError: toolCallResult.synthesizeIsError ?? false,
				};
			}
			if (toolCallResult?.block) {
				return {
					block: true,
					reason: toolCallResult.reason ?? "blocked by extension",
				};
			}
		}

		return undefined;
	}

	// ─── Error repeat guard ───

	private async handleAfterToolCall(
		toolCall: { name: string; id: string },
		args: unknown,
		_result: AgentToolResult<unknown>,
		isError: boolean,
	): Promise<AfterToolCallResult | undefined> {
		if (!isError) {
			this.errorGuard.recordSuccess(toolCall.name, args);
			return undefined;
		}

		const resultText = extractToolResultText(_result);
		const guardResult = this.errorGuard.recordError(
			toolCall.name,
			args as Record<string, unknown>,
			resultText,
			(_result.details as { toolError?: { category?: string } } | undefined)?.toolError?.category,
		);

		if (guardResult.shouldStop) {
			return {
				content: [
					{
						type: "text" as const,
						text: `[${toolCall.name}] Same tool call failed ${guardResult.repeatCount} times. Stop retrying.`,
					},
				],
				isError: true,
				terminate: true,
			};
		}

		// Extension tool_result hooks (mirrors AgentSession.afterToolCall ordering:
		// after the error-repeat guard). emitToolResult surfaces any extension-modified
		// content back to the model. Errors are isolated inside the runner, so no
		// try/catch is needed here.
		const runner = this.config.extensionRunnerRef?.current;
		if (runner && (runner.hasHandlers("tool_result") || runner.hasHandlers("after_tool_call"))) {
			const hook = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: extractToolResultText(_result)
					? [{ type: "text", text: extractToolResultText(_result) }]
					: (_result.content as (TextContent | ImageContent)[]),
				details: _result.details,
				isError,
			});
			if (hook?.content) {
				return {
					content: hook.content,
					details: hook.details,
					isError: hook.isError ?? isError,
				};
			}
		}

		return undefined;
	}

	// ─── System prompt (per-turn context refresh) ───

	/** Combine the base role prompt with the current project context block. */
	private buildSystemPrompt(): string {
		const context = this.config.getProjectContext?.() ?? this.initialContext;
		return context ? `${this.baseSystemPrompt}\n\n${context}` : this.baseSystemPrompt;
	}

	// ─── Thinking governor ───

	/**
	 * Backstop overthinking check on finalized messages. The primary mechanism is
	 * incremental `recordDelta` on `thinking_delta` events (wired in
	 * handleMessageUpdate), which steers feedback + aborts via the governor's
	 * onOverthinking. Some providers emit thinking only as a single finalized
	 * block without deltas, so re-run the governor over the message content here.
	 */
	private checkThinkingBudget(msg: AssistantMessage): void {
		let thinkingText = "";
		for (const content of msg.content) {
			if (content.type === "thinking") {
				thinkingText += (content as { thinking: string }).thinking;
			}
		}
		if (!thinkingText) return;
		this.thinkingGovernor.recordDelta(this.config.role, thinkingText);
	}

	// ─── Compaction ───

	private async compactContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		const tokens = estimateTokensFromMessages(messages);
		const threshold = this.config.contextLimit * 0.8;
		if (tokens < threshold) return messages;
		if (signal?.aborted) return messages;

		// Keep the initial task (first user message) + recent messages.
		const initialTask = messages[0];
		const keepRecent = Math.min(8, Math.max(3, Math.floor(this.config.contextLimit / 16000)));
		let keepFromIndex = Math.max(1, messages.length - keepRecent);
		while (keepFromIndex > 0 && messages[keepFromIndex]?.role === "toolResult") {
			keepFromIndex--;
		}
		const toCompact = messages.slice(1, keepFromIndex);
		const recent = messages.slice(keepFromIndex);
		if (toCompact.length === 0) return messages;

		// Build an extractive summary of the compacted region: truncated per-message
		// texts, capped at ~2000 chars. Better than a bare placeholder, cheaper than
		// an LLM summarization call (full LLM compaction is future work).
		const summary = this.extractiveSummary(toCompact);
		const note = summary
			? `[Context compacted. Extractive summary of earlier turns:]\n${summary}\n\n[Use scratchpad_load to retrieve saved findings.]`
			: "[Context compacted: earlier messages removed. Use scratchpad_load to retrieve saved findings.]";

		return [
			initialTask,
			{
				role: "user",
				content: note,
				timestamp: Date.now(),
			} as AgentMessage,
			...recent,
		];
	}

	/** Concatenate truncated per-message texts, capped proportionally to the model's context window. */
	private extractiveSummary(messages: AgentMessage[]): string {
		const cap = Math.max(2000, Math.floor(this.config.contextLimit * KEEP_MESSAGE_RATIO));
		const parts: string[] = [];
		let used = 0;
		for (const msg of messages) {
			const text = textFromContent((msg as { content: unknown }).content);
			if (!text) continue;
			const slice = text.length > 200 ? `${text.slice(0, 200)}…` : text;
			if (used + slice.length + 1 > cap) break;
			parts.push(`${msg.role}: ${slice}`);
			used += slice.length + 1;
		}
		return parts.join("\n");
	}

	// ─── Helpers ───

	private async publishEvent(type: string, payload: Record<string, unknown>): Promise<void> {
		await this.config.publishEvent?.(type, payload);
	}

	private lastAssistantText(): string | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role !== "assistant") continue;
			const text = textFromContent((message as { content: unknown }).content);
			if (text) return text;
		}
		return undefined;
	}

	private maxTurnsReportText(): string {
		const text = this.lastAssistantText();
		const prefix = `[Worker reached maximum turns (${this.maxTurns}); treating this as a partial report, not a clean completion.]`;
		return text ? `${prefix}\n\n${text}` : `${prefix}\n\nNo assistant report was produced before the turn limit.`;
	}

	/** Fallback text emitted when a worker finishes (stopReason "finished") with no
	 * usable text report — e.g. its final assistant message contained only tool
	 * calls or thinking blocks. Informative and explicitly not a "maximum turns"
	 * message, since the worker reached a clean finish. */
	private finishedWithoutTextReport(): string {
		return "[Worker finished without a text report. The final assistant message contained only tool calls or non-text content.]";
	}

	private lastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	private extractText(msg: AssistantMessage): string {
		return textFromContent(msg.content);
	}

	private extractToolText(content: unknown): string {
		return textFromContent(content);
	}

	private extractToolUpdateText(partialResult: unknown): string {
		if (!partialResult || typeof partialResult !== "object") return "";
		const result = partialResult as AgentToolResult<unknown>;
		return extractToolResultText(result);
	}
}

// ─── Module-level helpers ───

function estimateTokensFromMessages(messages: AgentMessage[]): number {
	let chars = 0;
	for (const msg of messages) {
		const content = (msg as { content: unknown }).content;
		if (typeof content === "string") {
			chars += content.length;
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part === "object" && part !== null && "text" in part) {
					chars += String((part as { text: string }).text).length;
				}
			}
		}
	}
	return Math.ceil(chars / 4);
}

function extractToolResultText(result: AgentToolResult<unknown>): string {
	const text = result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
	if (text) return text;
	const fallback = JSON.stringify(result.details ?? result, null, 2);
	return fallback.length > 2000 ? `${fallback.slice(0, 2000)}\n... [truncated]` : fallback;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part
				? String(part.text)
				: "",
		)
		.filter(Boolean)
		.join("\n")
		.trim();
}
