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

import type { Model } from "@piki/ai";
import {
	allowUnknownFieldsForStreaming,
	composePayloadHooks,
	createGrammarInjector,
	createStructuredOutputInjector,
	formatCorrectiveFeedback,
	StreamingFieldParser,
	typeboxToStreamingSchema,
} from "@piki/ai";
import type { AssistantMessage } from "@piki/ai/compat";
import { ROLE_DEFINITIONS } from "@piki/event-core";
import type { TSchema } from "typebox";
import { ErrorRepeatGuard } from "./error-repeat-guard.ts";
import { checkInputForGuardedPaths } from "./permissions/guarded-paths.ts";
import { evaluatePermission, type PermissionRule } from "./permissions/permission-gate.ts";
import { getRolePolicyRules } from "./permissions/role-policy.ts";
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
	userRules?: PermissionRule[];
	streamFn?: StreamFn;
	publishEvent?: (type: string, payload: Record<string, unknown>) => Promise<void> | void;
	onFinished: (result: { text: string; forkId: string; agentId: string; stopReason?: string }) => void;
	onError: (error: { error: string; forkId: string; agentId: string }) => void;
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

/** Mutating tools that need guarded-path checks. */
const MUTATING_TOOLS = new Set(["edit", "write", "bash", "edit-diff", "restore_snapshot"]);
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
	private readonly errorGuard = new ErrorRepeatGuard({ threshold: 3 });
	private thinkingCharCount = 0;
	private turnCount = 0;
	private stoppedForMaxTurns = false;
	private maxTurnWarningSent = false;
	private loopActive = false;
	private finished = false;
	private killed = false;
	private readonly maxTurns: number;
	private readonly streamingParsers = new Map<string, StreamingFieldParser>();
	private pendingToolValidationFeedback: string | undefined = undefined;
	private retryAttempt = 0;
	private readonly maxValidationRetries = 3;

	constructor(config: WorkerSessionConfig) {
		this.config = config;
		this.maxTurns = config.maxTurns ?? 30;

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
				systemPrompt: config.systemPrompt,
				model: config.model,
				thinkingLevel: config.model.reasoning ? "medium" : "off",
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
			toolExecution: "parallel",
			transformContext: async (messages, signal) => this.compactContext(messages, signal),
		});

		// Wire beforeToolCall: permission gate + guarded paths
		this.agent.beforeToolCall = async (ctx, signal) =>
			this.checkPermissions(ctx.toolCall.name, ctx.toolCall.id, ctx.args as Record<string, unknown>, signal);

		// Wire afterToolCall: error repeat guard
		this.agent.afterToolCall = async (ctx, _signal) =>
			this.handleAfterToolCall(ctx.toolCall, ctx.args, ctx.result, ctx.isError);

		// Subscribe to agent events and re-publish to fork
		this.unsubscribe = this.agent.subscribe((event, signal) => this.handleAgentEvent(event, signal));
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
			});
			return;
		}

		if (lastAssistant?.stopReason === "error") {
			this.config.onError({
				error: `Worker LLM error: ${lastAssistant.errorMessage ?? "unknown"}`,
				forkId: this.config.forkId,
				agentId: this.config.agentId,
			});
			return;
		}

		// Success or max_turns
		this.config.onFinished({
			text: this.lastAssistantText() ?? "[Worker reached maximum turns without finishing]",
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
		// Set fork context for detached process tracking
		setForkContext(this.config.forkId);

		const permissionDecision = evaluatePermission(toolName, args, {
			interactive: false,
			context: "subagent",
			knownTools: this.config.tools.map((t) => t.name),
			userRules: this.config.userRules ?? [],
			roleId: this.config.role,
			rolePolicyRules: getRolePolicyRules(this.config.role, this.config.cwd, this.config.scratchpadPath),
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
		const guardResult = this.errorGuard.recordError(toolCall.name, args as Record<string, unknown>, resultText);

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

		return undefined;
	}

	// ─── Thinking governor ───

	private checkThinkingBudget(msg: AssistantMessage): void {
		let thinkingText = "";
		for (const content of msg.content) {
			if (content.type === "thinking") {
				thinkingText += (content as { thinking: string }).thinking;
			}
		}
		if (!thinkingText) return;

		this.thinkingCharCount += thinkingText.length;
		const roleDef = ROLE_DEFINITIONS[this.config.role];
		const maxThoughtChars = roleDef?.maxThoughtChars ?? 20000;
		if (this.thinkingCharCount > maxThoughtChars) {
			this.agent.steer({
				role: "user",
				content:
					"[System: You have exceeded the thinking budget for this task. Please wrap up your reasoning and proceed to take action or provide your final answer.]",
				timestamp: Date.now(),
			} as AgentMessage);
			this.thinkingCharCount = 0;
		}
	}

	// ─── Compaction ───

	private async compactContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		const tokens = estimateTokensFromMessages(messages);
		const threshold = this.config.contextLimit * 0.8;
		if (tokens < threshold) return messages;
		if (signal?.aborted) return messages;

		// Keep the initial task (first user message) + recent messages.
		const initialTask = messages[0];
		let keepFromIndex = Math.max(1, messages.length - 8);
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

	/** Concatenate truncated per-message texts, capped at ~2000 chars total. */
	private extractiveSummary(messages: AgentMessage[]): string {
		const cap = 2000;
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
