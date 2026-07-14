import type { AgentMessage } from "@piki/agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@piki/ai";
import { Container, Text, type TUI } from "@piki/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import type { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionItems = (
	this: RenderSessionContextThis,
	items: AgentMessage[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type RenderSessionContextThis = {
	pendingTools: Map<string, ToolExecutionComponent>;
	runtimeWorkerTree: Map<string, unknown>;
	runtimeWorkerTreeComponent: Text | undefined;
	toolTimelineEntries: Map<string, unknown>;
	toolTimelineComponent: Text | undefined;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
		getShowCacheMissNotices(): boolean;
	};
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[] };
	session: { retryAttempt: number; modelRegistry: { find(provider: string, modelId: string): undefined } };
	toolOutputExpanded: boolean;
	isInitialized: boolean;
	updateEditorBorderColor(): void;
	getRegisteredToolDefinition(toolName: string): undefined;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	shortRuntimeId(value: unknown): string | undefined;
	runtimeModelLabel(model: unknown): string | undefined;
	stringPayload(payload: Record<string, unknown>, key: string): string | undefined;
	ensureRuntimeWorker(payload: Record<string, unknown>): unknown;
	updateRuntimeWorkerTree(eventType: string, payload: Record<string, unknown>): void;
	renderRuntimeWorkerTree(): void;
	formatRuntimeLifecycleLine(eventType: string, payload: Record<string, unknown>): string | undefined;
	handleRuntimeEventForUi(eventType: string, payload: Record<string, unknown>): void;
	updateToolTimeline(
		toolCallId: string,
		toolName: string,
		status: "queued" | "running" | "succeeded" | "failed",
	): void;
	renderToolTimeline(): void;
	renderSessionItems: RenderSessionItems;
};

type RenderSessionEntries = (
	this: RenderSessionContextThis,
	entries: SessionEntry[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type HandleEvent = (this: RenderSessionContextThis, event: AgentSessionEvent) => Promise<void>;

function createFakeInteractiveModeThis(): RenderSessionContextThis {
	const chatContainer = new Container();
	const prototype = InteractiveMode.prototype as unknown as Pick<
		RenderSessionContextThis,
		| "shortRuntimeId"
		| "runtimeModelLabel"
		| "stringPayload"
		| "ensureRuntimeWorker"
		| "updateRuntimeWorkerTree"
		| "renderRuntimeWorkerTree"
		| "formatRuntimeLifecycleLine"
		| "handleRuntimeEventForUi"
		| "updateToolTimeline"
		| "renderToolTimeline"
	>;
	return {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		runtimeWorkerTree: new Map<string, unknown>(),
		runtimeWorkerTreeComponent: undefined,
		toolTimelineEntries: new Map<string, unknown>(),
		toolTimelineComponent: undefined,
		chatContainer,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowCacheMissNotices: () => false,
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
		session: { retryAttempt: 0, modelRegistry: { find: () => undefined } },
		toolOutputExpanded: false,
		isInitialized: true,
		updateEditorBorderColor: vi.fn(),
		getRegisteredToolDefinition: (_toolName: string) => undefined,
		renderSessionItems: (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems,
		addMessageToChat(message: AgentMessage) {
			chatContainer.addChild(new Text(message.role, 0, 0));
		},
		shortRuntimeId: prototype.shortRuntimeId,
		runtimeModelLabel: prototype.runtimeModelLabel,
		stringPayload: prototype.stringPayload,
		ensureRuntimeWorker: prototype.ensureRuntimeWorker,
		updateRuntimeWorkerTree: prototype.updateRuntimeWorkerTree,
		renderRuntimeWorkerTree: prototype.renderRuntimeWorkerTree,
		formatRuntimeLifecycleLine: prototype.formatRuntimeLifecycleLine,
		handleRuntimeEventForUi: prototype.handleRuntimeEventForUi,
		updateToolTimeline: prototype.updateToolTimeline,
		renderToolTimeline: prototype.renderToolTimeline,
	};
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionEntries(messages: AgentMessage[]): SessionEntry[] {
	let parentId: string | null = null;
	return messages.map((message, index) => {
		const entry: SessionEntry = {
			type: "message",
			id: `entry-${index}`,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		};
		parentId = entry.id;
		return entry;
	});
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode.renderSessionEntries", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps unresolved rendered tool calls registered for live completion events", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		renderSessionEntries.call(fakeThis, createSessionEntries([createAssistantToolCallMessage()]));

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(true);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: undefined },
			isError: false,
		});

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(false);
		expect(renderChat(fakeThis.chatContainer)).toContain("FINAL_RESULT");
	});

	test("does not keep completed historical tool calls registered as pending", () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;

		renderSessionEntries.call(
			fakeThis,
			createSessionEntries([createAssistantToolCallMessage(), createToolResultMessage("HISTORICAL_RESULT")]),
		);

		expect(fakeThis.pendingTools.size).toBe(0);
		expect(renderChat(fakeThis.chatContainer)).toContain("HISTORICAL_RESULT");
	});

	test("renders runtime worker lifecycle events and updates compact worker tree", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "runtime_event",
			runtimeEventType: "agent_created",
			payload: {
				agentId: "worker-123456789",
				forkId: "fork-123456789",
				parentForkId: "leader-1",
				role: "scout",
				mode: "spawn",
				taskId: "task-1",
				model: { provider: "test", id: "fast" },
			},
		});

		await handleEvent.call(fakeThis, {
			type: "runtime_event",
			runtimeEventType: "worker_finished",
			payload: {
				agentId: "worker-123456789",
				forkId: "fork-123456789",
				role: "scout",
				stopReason: "finished",
			},
		});

		const rendered = renderChat(fakeThis.chatContainer);
		expect(rendered).toContain("Worker scout spawned worker-1 task:task-1 model:test/fast");
		expect(rendered).toContain("Worker scout finished worker-1 (finished)");
		expect(rendered).toContain("Workers");
		expect(rendered).toContain("leader");
		expect(rendered).toContain("scout worker-1 task:task-1  done:finished  test/fast");
	});

	test("renders worker error stop reason when present", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "runtime_event",
			runtimeEventType: "worker_error",
			payload: {
				agentId: "worker-error-123",
				forkId: "fork-error-123",
				role: "scout",
				stopReason: "error",
				error: "rate limited",
			},
		});

		const rendered = renderChat(fakeThis.chatContainer);
		expect(rendered).toContain("Worker scout errored worker-e (error)");
		expect(rendered).toContain("scout worker-e  error:error");
	});

	test("renders compact tool timeline status while tools execute", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolCallId: "tool-a",
			toolName: "read",
			args: { path: "a.ts" },
		});
		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolCallId: "tool-b",
			toolName: "bash",
			args: { command: "echo ok" },
		});

		let rendered = renderChat(fakeThis.chatContainer);
		expect(rendered).toContain("2 tools running");
		expect(rendered).toContain("read:running");
		expect(rendered).toContain("bash:running");

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: "tool-a",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }], details: undefined },
			isError: false,
		});

		rendered = renderChat(fakeThis.chatContainer);
		expect(rendered).toContain("1 tool running");
		expect(rendered).toContain("read:succeeded");
		expect(rendered).toContain("bash:running");
	});
});
