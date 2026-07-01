/**
 * WorkerSession - runs an LLM agent loop for a forked worker.
 *
 * Delegates to the full Agent class from @earendil-works/pi-agent-core,
 * matching the leader's AgentSession pattern:
 * - Grammar injection (GBNF for open-weight models)
 * - Structured output injection (provider-native for frontier APIs)
 * - Parallel tool execution with beforeToolCall/afterToolCall hooks
 * - Mid-stream tool argument validation via StreamingFieldParser
 * - Event subscription model for fork visibility
 * - Lightweight compaction via transformContext
 */

import {
	type AfterToolCallResult,
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { composePayloadHooks, createGrammarInjector, createStructuredOutputInjector } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { ROLE_DEFINITIONS } from "@earendil-works/pi-event-core";
import type { TSchema } from "typebox";
import { ErrorRepeatGuard } from "./error-repeat-guard.ts";
import { checkInputForGuardedPaths } from "./permissions/guarded-paths.ts";
import { evaluatePermission, type PermissionRule } from "./permissions/permission-gate.ts";
import { setForkContext } from "./worker-executor.ts";

export interface WorkerTool {
	name: string;
	description: string;
	parameters: TSchema;
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
	maxTurns?: number;
	userRules?: PermissionRule[];
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
		execute: tool.execute,
	};
}

/** Mutating tools that need guarded-path checks. */
const MUTATING_TOOLS = new Set(["edit", "write", "bash", "edit-diff", "restore_snapshot"]);

export class WorkerSession {
	private readonly config: WorkerSessionConfig;
	private readonly agent: Agent;
	private readonly unsubscribe: () => void;
	private readonly errorGuard = new ErrorRepeatGuard({ threshold: 3 });
	private thinkingCharCount = 0;
	private turnCount = 0;
	private readonly maxTurns: number;

	constructor(config: WorkerSessionConfig) {
		this.config = config;
		this.maxTurns = config.maxTurns ?? 15;

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
	}

	kill(): void {
		this.agent.abort();
	}

	async start(): Promise<void> {
		try {
			await this.agent.continue();
		} catch (err) {
			this.unsubscribe();
			this.config.onError({
				error: `Worker session crashed: ${err instanceof Error ? err.message : String(err)}`,
				forkId: this.config.forkId,
				agentId: this.config.agentId,
			});
			return;
		}

		this.unsubscribe();

		// Check final state
		const messages = this.agent.state.messages;
		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") as AssistantMessage | undefined;

		if (this.agent.signal?.aborted || lastAssistant?.stopReason === "aborted") {
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
			stopReason: this.turnCount >= this.maxTurns ? "max_turns" : undefined,
		});
	}

	// ─── Event handling ───

	private async handleAgentEvent(event: AgentEvent, _signal: AbortSignal): Promise<void> {
		switch (event.type) {
			case "message_end":
				if (event.message.role === "assistant") {
					const msg = event.message as AssistantMessage;
					this.checkThinkingBudget(msg);
					const text = this.extractText(msg);
					await this.publishEvent("message_end", {
						messageRole: "assistant",
						text,
						stopReason: msg.stopReason,
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
					this.agent.abort();
				}
				break;

			case "agent_end":
				// start() await resolves after this
				break;
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

		// Keep the initial task (first user message) + recent messages
		const initialTask = messages[0];
		let keepFromIndex = Math.max(1, messages.length - 5);
		while (keepFromIndex > 0 && messages[keepFromIndex]?.role === "toolResult") {
			keepFromIndex--;
		}
		const recent = messages.slice(keepFromIndex);
		return [
			initialTask,
			{
				role: "user",
				content: "[Context compacted: earlier messages removed. Use scratchpad_load to retrieve saved findings.]",
				timestamp: Date.now(),
			} as AgentMessage,
			...recent,
		];
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
