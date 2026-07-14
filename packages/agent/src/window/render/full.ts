/**
 * Window full prompt renderer.
 *
 * Consumes the `WindowState`, `SystemPrompt`, and other window
 * inputs, and emits the final `Prompt` object ready for the model.
 *
 * Delegates per-turn truncation to `createTruncatingFormatter` and large
 * timeline rendering to the inlined capture helpers (system/context/feedback
 * entry converters). No Effect, layer, Cortex, or projection imports.
 */

import { renderXmlBodyValue } from "@piki/agent-core";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@piki/ai/prompt/messages";
import { Prompt } from "@piki/ai/prompt/prompt";
import { ContentBuilder, type ContentPart, type ToolResultFormatter } from "@piki/harness";
import { createTruncatingFormatter } from "./formatters.ts";
import { contextEntryToMessages, ensureTerminalUserMessage, renderFeedback, systemEntryToMessages } from "./shared.ts";
import { createTimeBoundaryEmitter, formatTime } from "./time-boundaries.ts";

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/** A single tool result entry as produced by the turn and stored in the window. */
export interface WindowToolResultEntry {
	toolCallId: string;
	providerToolCallId: string;
	toolName: string;
	result: { _tag: string; output?: unknown; message?: string; error?: unknown; denial?: unknown };
}

/** A feedback item rendered into the prompt after a turn. */
export type FeedbackEntry =
	| { kind: "message_ack"; destination: string; chars: number }
	| { kind: "error"; message: string }
	| { kind: "overthinking"; message: string }
	| { kind: "interrupted" };

/** A single assistant turn as stored in the window state. */
export interface WindowTurn {
	turnId: string;
	assistant: AssistantMessage;
	toolResults: WindowToolResultEntry[];
	feedback: FeedbackEntry[];
}

/** A window message union, matching the `WindowState.messages`. */
export type WindowMessage =
	| { type: "observer_turn" }
	| { type: "session_context"; content: ContentPart[] }
	| { type: "fork_context"; content: ContentPart[] }
	| { type: "goal_injection"; content: ContentPart[] }
	| { type: "compacted"; content: ContentPart[] }
	| { type: "assistant_turn"; turn: WindowTurn }
	| { type: "advisor_response"; content: string }
	| { type: "context"; timeline: TimelineEntry[] };

/** The window state consumed by the renderer. */
export interface WindowState {
	messages: WindowMessage[];
}

/** Minimal agent snapshot used by timeline rendering. */
export interface AgentStatusLike {
	agents: Map<string, { role?: string; status?: string }>;
}

/** Minimal detached background process entry used by timeline rendering. */
export interface DetachedProcessStateLike {
	processes: Map<
		string,
		{
			pid: number;
			command: string;
			status: "running" | "completed";
			forkId: string | null;
			ownerAgentId?: string | null;
			startedAt: number;
			cpuPercent?: number | null;
			rssBytes?: number | null;
			exitCode?: number;
			peakCpuPercent?: number | null;
			peakRssBytes?: number | null;
			stdoutPath?: string;
			stderrPath?: string;
		}
	>;
}

/** Timeline entry kinds rendered by `renderTimeline`. */
export type TimelineEntry =
	| { kind: "turn_start"; timestamp: number }
	| { kind: "turn_end" }
	| { kind: "lifecycle_hook" }
	| { kind: "task_idle_hook"; agentId: string; taskId: string; title: string }
	| { kind: "task_complete_hook"; taskId: string; title: string }
	| { kind: "task_tree_view"; renderedTree: string }
	| {
			kind: "task_update";
			action: string;
			taskId: string;
			title?: string;
			cancelledCount?: number;
			previousStatus?: string;
			nextStatus?: string;
	  }
	| { kind: "user_message"; timestamp: number; text: string; synthetic?: boolean; attachments?: TimelineAttachment[] }
	| { kind: "observation"; timestamp: number; parts: ContentPart[] }
	| { kind: "agent_block"; timestamp: number; agentId: string; role: string; atoms: AgentAtom[] }
	| { kind: "coordinator_message"; timestamp: number; text: string }
	| {
			kind: "user_bash_command";
			timestamp: number;
			cwd: string;
			exitCode: number;
			command: string;
			stdout: string;
			stderr: string;
	  }
	| { kind: "user_to_agent"; timestamp: number; agentId: string; text: string }
	| { kind: "worker_user_killed"; timestamp: number; agentId: string; agentType: string }
	| {
			kind: "detached_process_exited";
			timestamp: number;
			pid: number;
			command: string;
			exitCode: number;
			stdoutPath: string;
			stderrPath: string;
	  }
	| { kind: "escalation"; timestamp: number; observedForkId: string | null; justification?: string }
	| { kind: "task_start_hook" }
	| { kind: "task_tree_dirty" }
	| { kind: "task_reassigned" };

export interface TimelineAttachment {
	kind: "image";
	description?: string;
	image?: ContentPart & { _tag: "ImagePart" };
	error?: string;
	contentType: string;
	path?: string;
	content?: string;
	truncated?: boolean;
	originalBytes?: number;
	lineRange?: { start: number; end: number };
}

export type AgentAtom =
	| { kind: "thought"; text: string }
	| { kind: "tool_call"; toolName: string; attributes: Record<string, string>; body: string }
	| { kind: "message"; direction: "to_lead" | "from_user" | "from_lead"; text: string }
	| { kind: "error"; message: string }
	| { kind: "idle" };

/** Input shape for `windowToPrompt`,. */
export interface WindowToPromptInput {
	windowState: WindowState;
	systemPrompt: string;
	timezone?: string;
	agentStatus?: AgentStatusLike;
	formatter: ToolResultFormatter;
	detachedProcessState?: DetachedProcessStateLike;
	forkId?: string;
	autopilotEnabled?: boolean;
	leaderLastAutopilotKnowledge?: string;
}

function truncateBody(body: string, maxChars: number): string {
	if (body.length <= maxChars) return body;
	return `${body.slice(0, maxChars)}... (truncated)`;
}

const DEFAULT_MAX_BODY_CHARS = 500;

function renderCompactToolCall(input: {
	toolName: string;
	attributes: Record<string, string>;
	body?: string;
	maxBodyChars?: number;
}): string {
	const { toolName, attributes, body } = input;
	const maxBodyChars = input.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
	const attrs = Object.entries(attributes)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => ` ${key}="${value}"`)
		.join("");
	if (!body || body.length === 0) {
		return `<${toolName}${attrs}/>`;
	}
	const safeBody = truncateBody(body, maxBodyChars);
	return `<${toolName}${attrs}>${safeBody}</${toolName}>`;
}

function renderAgentAtom(atom: AgentAtom): string {
	switch (atom.kind) {
		case "thought":
			return atom.text;
		case "tool_call":
			return renderCompactToolCall({
				toolName: atom.toolName,
				attributes: { ...atom.attributes },
				body: atom.body,
			});
		case "message": {
			const dir =
				atom.direction === "to_lead" ? 'to="lead"' : atom.direction === "from_user" ? 'from="user"' : 'from="lead"';
			return `<message ${dir}>${atom.text}</message>`;
		}
		case "error":
			return `<error>${atom.message}</error>`;
		case "idle":
			return "<" + "yield_user/>";
	}
}

function renderTimelineTextLines(
	entry: TimelineEntry,
	agentsMap: Map<string, { role?: string; status?: string }>,
): string[] {
	switch (entry.kind) {
		case "user_message":
			return [`<message from="user">${entry.text}</message>`];
		case "coordinator_message":
			return [`<message from="coordinator">${entry.text}</message>`];
		case "user_bash_command":
			return [
				`<user_bash_command cwd="${entry.cwd}" exit_code="${entry.exitCode}">
<command>${entry.command}</command>
<stdout>${entry.stdout}</stdout>
<stderr>${entry.stderr}</stderr>
</user_bash_command>`,
			];
		case "user_to_agent":
			return [`<user-to-agent agent="${entry.agentId}">${entry.text}</user-to-agent>`];
		case "agent_block": {
			const lines = entry.atoms.map(renderAgentAtom).join("\n");
			const status = agentsMap.get(entry.agentId)?.status ?? "idle";
			return [
				`<agent id="${entry.agentId}" role="${entry.role}" status="${status}">
${lines}
</agent>`,
			];
		}
		case "worker_user_killed":
			return [`<subagent-user-killed agent="${entry.agentId}" type="${entry.agentType}"/>`];
		case "detached_process_exited":
			return [
				`<detached_process_exited pid="${entry.pid}" command="${entry.command}" exit_code="${entry.exitCode}">
<stdout_path>${entry.stdoutPath}</stdout_path>
<stderr_path>${entry.stderrPath}</stderr_path>
</detached_process_exited>`,
			];
		case "escalation": {
			if (entry.observedForkId === null) return [];
			return [
				`<observer_notification>${entry.justification ?? "Observer recommends contacting advisor."}</observer_notification>`,
			];
		}
		default:
			return [];
	}
}

function maybeAttentionBullet(
	entry: TimelineEntry,
	timezone: string | undefined,
	agentsMap: Map<string, { role?: string; status?: string }>,
): string | null {
	if (entry.kind === "user_message") return `- user message at ${formatTime(entry.timestamp, timezone)}`;
	if (entry.kind === "user_bash_command") return `- user ran bash command at ${formatTime(entry.timestamp, timezone)}`;
	if (entry.kind === "escalation" && entry.observedForkId === null) return null;
	if (entry.kind === "agent_block") {
		if (entry.atoms.some((a) => a.kind === "error"))
			return `- ${entry.agentId} errored at ${formatTime(entry.timestamp, timezone)}`;
		const agent = agentsMap.get(entry.agentId);
		if (!agent || agent.status === "idle")
			return `- ${entry.agentId} went idle at ${formatTime(entry.timestamp, timezone)}`;
	}
	return null;
}

function formatCpu(value?: number | null): string {
	if (value == null) return "";
	return `${Math.round(value)}%`;
}

function formatMemory(bytes?: number | null): string {
	if (bytes == null) return "";
	const mb = bytes / (1024 * 1024);
	if (mb < 1024) return `${Math.round(mb)}MB`;
	const gb = mb / 1024;
	if (gb < 1024) return `${gb.toFixed(1)}GB`;
	return `${(gb / 1024).toFixed(1)}TB`;
}

function buildBackgroundProcessesLines(
	detachedState: DetachedProcessStateLike | undefined,
	forkId: string | undefined,
	now: number,
): string[] {
	if (!detachedState) return [];
	const relevant = [...detachedState.processes.values()].filter((proc) => forkId === null || proc.forkId === forkId);
	if (relevant.length === 0) return [];
	return relevant.map((proc) => {
		const ownerLabel = forkId === null && proc.ownerAgentId ? ` (worker: ${proc.ownerAgentId})` : "";
		if (proc.status === "running") {
			const elapsed = Math.floor((now - proc.startedAt) / 1000);
			const metricsLabel =
				proc.cpuPercent != null && proc.rssBytes != null
					? ` cpu ${formatCpu(proc.cpuPercent)} mem ${formatMemory(proc.rssBytes)}`
					: "";
			return `pid ${proc.pid} \`${proc.command}\` running ${elapsed}s${metricsLabel}${ownerLabel}`;
		}
		const peakMetrics =
			proc.peakCpuPercent != null && proc.peakRssBytes != null
				? `, peak cpu ${formatCpu(proc.peakCpuPercent)}, peak mem ${formatMemory(proc.peakRssBytes)}`
				: "";
		return `pid ${proc.pid} \`${proc.command}\` completed (exit ${proc.exitCode}${peakMetrics}). stdout: ${proc.stdoutPath}, stderr: ${proc.stderrPath}${ownerLabel}`;
	});
}

function hasWorkerToLeadMessage(entry: { atoms: AgentAtom[] }): boolean {
	return entry.atoms.some((atom) => atom.kind === "message" && atom.direction === "to_lead");
}

function renderTaskUpdateLine(entry: Extract<TimelineEntry, { kind: "task_update" }>): string {
	if (entry.action === "created") {
		const title = entry.title ? `: "${entry.title}"` : "";
		return `- Task ${entry.taskId} created${title}`;
	}
	if (entry.action === "cancelled") {
		const cancelledSuffix = entry.cancelledCount != null ? ` (${entry.cancelledCount} tasks removed)` : "";
		return `- Task ${entry.taskId} cancelled${cancelledSuffix}`;
	}
	if (entry.action === "completed") {
		return `- Task ${entry.taskId} completed`;
	}
	const previousStatus = entry.previousStatus ?? "unknown";
	const nextStatus = entry.nextStatus ?? "unknown";
	return `- Task ${entry.taskId} status changed: ${previousStatus} -> ${nextStatus}`;
}

const taskIdleReminder = (agentId: string, taskId: string, title: string): string =>
	`Worker ${agentId} for task ${taskId} ("${title}") has finished. Review output and either send feedback or mark complete.`;

const taskCompleteReminder = (taskId: string, title: string): string => `Task ${taskId} ("${title}") completed.`;

const WORKER_PROGRESS_USER_MESSAGE_REMINDER = "Surface relevant worker progress to the user in a message this turn.";

function buildTaskIdleReminderLines(hooks: Extract<TimelineEntry, { kind: "task_idle_hook" }>[]): string[] {
	if (hooks.length === 0) return [];
	const byTask = new Map<string, Extract<TimelineEntry, { kind: "task_idle_hook" }>>();
	for (const hook of hooks) byTask.set(hook.taskId, hook);
	return Array.from(byTask.values()).map((hook) => taskIdleReminder(hook.agentId, hook.taskId, hook.title));
}

function buildTaskCompleteReminderLines(hooks: Extract<TimelineEntry, { kind: "task_complete_hook" }>[]): string[] {
	if (hooks.length === 0) return [];
	const byTask = new Map<string, Extract<TimelineEntry, { kind: "task_complete_hook" }>>();
	for (const hook of hooks) byTask.set(hook.taskId, hook);
	return Array.from(byTask.values()).map((hook) => taskCompleteReminder(hook.taskId, hook.title));
}

function renderEscalationMessage(justification: string): string {
	return `<escalation_required>
${justification}
</escalation_required>`;
}

export function renderTimeline(input: {
	timeline: TimelineEntry[];
	timezone?: string;
	agentStatus?: AgentStatusLike;
	detachedProcessState?: DetachedProcessStateLike;
	forkId?: string;
}): ContentPart[] {
	const builder = new ContentBuilder();
	if (input.timeline.length === 0) return builder.build();
	const agentsMap = input.agentStatus?.agents ?? new Map();
	const timeBoundaries = createTimeBoundaryEmitter(input.timezone);
	let hasWorkerMessage = false;
	const lifecycleHooks: TimelineEntry[] = [];
	const taskIdleHooks: Extract<TimelineEntry, { kind: "task_idle_hook" }>[] = [];
	const taskCompleteHooks: Extract<TimelineEntry, { kind: "task_complete_hook" }>[] = [];
	const treeViews: Extract<TimelineEntry, { kind: "task_tree_view" }>[] = [];
	const taskUpdates: Extract<TimelineEntry, { kind: "task_update" }>[] = [];
	const attentionItems: { bullet: string; kind: string }[] = [];
	const escalationEntries: Extract<TimelineEntry, { kind: "escalation" }>[] = [];
	const isChronological = (e: TimelineEntry): boolean =>
		e.kind === "user_message" ||
		e.kind === "observation" ||
		e.kind === "agent_block" ||
		e.kind === "coordinator_message" ||
		e.kind === "user_bash_command" ||
		e.kind === "user_to_agent" ||
		e.kind === "worker_user_killed" ||
		e.kind === "detached_process_exited" ||
		(e.kind === "escalation" && e.observedForkId !== null);
	const chronologicalIndices = input.timeline.map((e, i) => (isChronological(e) ? i : -1)).filter((i) => i !== -1);
	const lastChronologicalIndex = chronologicalIndices[chronologicalIndices.length - 1] ?? -1;
	const hasAnyLifecycleHook = input.timeline.some((e) => e.kind === "lifecycle_hook");
	function emitTimeBoundary(timestamp: number): void {
		const marker = timeBoundaries.next(timestamp);
		if (!marker) return;
		builder.pushText(`${builder.hasContent() ? "\n\n" : ""}${marker}`);
	}
	for (let i = 0; i < input.timeline.length; i++) {
		const entry = input.timeline[i];
		switch (entry.kind) {
			case "turn_start": {
				emitTimeBoundary(entry.timestamp);
				break;
			}
			case "turn_end": {
				break;
			}
			case "lifecycle_hook": {
				lifecycleHooks.push(entry);
				break;
			}
			case "task_idle_hook": {
				taskIdleHooks.push(entry);
				break;
			}
			case "task_complete_hook": {
				taskCompleteHooks.push(entry);
				break;
			}
			case "task_tree_view": {
				treeViews.push(entry);
				break;
			}
			case "task_update": {
				taskUpdates.push(entry);
				break;
			}
			case "user_message": {
				emitTimeBoundary(entry.timestamp);
				builder.pushText(`\n<message from="user">${entry.text}</message>`);
				const bullet = maybeAttentionBullet(entry, input.timezone, agentsMap);
				if (bullet && (i !== lastChronologicalIndex || hasAnyLifecycleHook)) {
					attentionItems.push({ bullet, kind: entry.kind });
				}
				break;
			}
			case "observation": {
				emitTimeBoundary(entry.timestamp);
				for (const part of entry.parts) {
					if (part._tag === "TextPart") builder.pushText(`\n${part.text}`);
					else builder.pushPart(part);
				}
				break;
			}
			case "agent_block": {
				if (hasWorkerToLeadMessage(entry)) hasWorkerMessage = true;
				emitTimeBoundary(entry.timestamp);
				for (const line of renderTimelineTextLines(entry, agentsMap)) {
					builder.pushText(`\n${line}`);
				}
				const bullet = maybeAttentionBullet(entry, input.timezone, agentsMap);
				if (bullet && (i !== lastChronologicalIndex || hasAnyLifecycleHook)) {
					attentionItems.push({ bullet, kind: entry.kind });
				}
				break;
			}
			case "coordinator_message":
			case "user_bash_command":
			case "user_to_agent":
			case "worker_user_killed":
			case "detached_process_exited":
			case "escalation": {
				emitTimeBoundary(entry.timestamp);
				for (const line of renderTimelineTextLines(entry, agentsMap)) {
					builder.pushText(`\n${line}`);
				}
				if (entry.kind === "escalation" && entry.observedForkId === null) {
					escalationEntries.push(entry);
				}
				const bullet = maybeAttentionBullet(entry, input.timezone, agentsMap);
				if (bullet && (i !== lastChronologicalIndex || hasAnyLifecycleHook)) {
					attentionItems.push({ bullet, kind: entry.kind });
				}
				break;
			}
			case "task_start_hook":
			case "task_tree_dirty":
			case "task_reassigned": {
				break;
			}
			default: {
				const _exhaustive: never = entry;
				void _exhaustive;
			}
		}
	}
	const reminderLines = [
		...(hasWorkerMessage ? [WORKER_PROGRESS_USER_MESSAGE_REMINDER] : []),
		...buildTaskIdleReminderLines(taskIdleHooks),
		...buildTaskCompleteReminderLines(taskCompleteHooks),
	];
	if (reminderLines.length > 0) {
		builder.pushText(
			`${builder.hasContent() ? "\n\n" : ""}<reminders>\n${reminderLines.map((line) => `- ${line}`).join("\n")}\n</reminders>`,
		);
	}
	if (taskUpdates.length > 0) {
		const lines = taskUpdates.map(renderTaskUpdateLine);
		builder.pushText(`${builder.hasContent() ? "\n\n" : ""}<task_updates>\n${lines.join("\n")}\n</task_updates>`);
	}
	if (treeViews.length > 0) {
		const latestTree = treeViews[treeViews.length - 1]?.renderedTree;
		if (latestTree) {
			builder.pushText(`\n\n<task_tree>\n${latestTree}\n</task_tree>`);
		}
	}
	const backgroundProcessLines = buildBackgroundProcessesLines(
		input.detachedProcessState,
		input.forkId ?? undefined,
		Date.now(),
	);
	if (backgroundProcessLines.length > 0) {
		builder.pushText(
			`${builder.hasContent() ? "\n\n" : ""}<background_processes>\n${backgroundProcessLines.map((line) => `- ${line}`).join("\n")}\n</background_processes>`,
		);
	}
	if (escalationEntries.length > 0) {
		for (const entry of escalationEntries) {
			if (entry.justification) {
				builder.pushText(`${builder.hasContent() ? "\n\n" : ""}${renderEscalationMessage(entry.justification)}`);
			}
		}
	}
	const trivialAttention = attentionItems.length === 1 && attentionItems[0]?.kind === "user_message";
	if (attentionItems.length > 0 && !trivialAttention) {
		builder.pushText(
			`${builder.hasContent() ? "\n\n" : ""}<attention>\n${attentionItems.map((item) => item.bullet).join("\n")}\n</attention>`,
		);
	}
	return builder.build();
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

function textMessage(text: string): UserMessage {
	return {
		_tag: "UserMessage",
		parts: [{ _tag: "TextPart", text }],
	};
}

function toolResultEntryToMessage(entry: WindowToolResultEntry, formatter: ToolResultFormatter): ToolResultMessage {
	const parts = formatter(entry as unknown as Parameters<ToolResultFormatter>[0]);
	return {
		_tag: "ToolResultMessage",
		toolCallId: entry.toolCallId,
		providerToolCallId: entry.providerToolCallId,
		toolName: entry.toolName,
		parts,
	};
}

/**
 * Render a full window into a `Prompt` for the model.
 */
export function windowToPrompt(input: WindowToPromptInput): Prompt {
	const { windowState, systemPrompt, timezone, agentStatus, formatter, detachedProcessState, forkId } = input;
	const messages: Message[] = [];
	for (const msg of windowState.messages) {
		switch (msg.type) {
			case "observer_turn":
				break;
			case "session_context":
			case "fork_context":
			case "goal_injection":
			case "compacted": {
				messages.push(...systemEntryToMessages(msg));
				break;
			}
			case "assistant_turn": {
				const { turn } = msg;
				messages.push(turn.assistant);
				const turnFormatter = createTruncatingFormatter(formatter, turn.turnId);
				for (const entry of turn.toolResults) {
					messages.push(toolResultEntryToMessage(entry, turnFormatter));
				}
				const feedbackParts = renderFeedback(turn.feedback);
				if (feedbackParts.length > 0) {
					messages.push({
						_tag: "UserMessage",
						parts: feedbackParts,
					});
				}
				break;
			}
			case "advisor_response": {
				break;
			}
			case "context": {
				messages.push(...contextEntryToMessages(msg, timezone, agentStatus, detachedProcessState, forkId));
				break;
			}
		}
	}
	const shouldShowToggle = false;
	if (shouldShowToggle) {
		let lastAssistantIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m._tag === "AssistantMessage") {
				lastAssistantIndex = i;
				break;
			}
		}
		if (lastAssistantIndex >= 0) {
			messages.splice(
				lastAssistantIndex,
				0,
				textMessage(`<autopilot_toggled enabled="${input.autopilotEnabled}" />`),
			);
		} else {
			messages.push(textMessage(`<autopilot_toggled enabled="${input.autopilotEnabled}" />`));
		}
	}
	const terminal = ensureTerminalUserMessage(messages, "(continue)");
	return Prompt.from({
		system: systemPrompt,
		messages: terminal,
	});
}

// Suppress unused-import lint for the re-export surface.
void renderXmlBodyValue;
