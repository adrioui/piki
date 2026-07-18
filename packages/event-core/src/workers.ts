import type { EventEnvelope, RoleDefinition } from "./types.ts";

type RuntimeEvent = EventEnvelope<string, Record<string, unknown>>;

function createEvent(base: RuntimeEvent, type: string, payload: Record<string, unknown>): RuntimeEvent {
	return {
		id: `${base.id}:${type}:${Date.now()}`,
		stream: base.stream,
		sequence: base.sequence + 1,
		type,
		timestamp: new Date().toISOString(),
		sessionId: base.sessionId,
		source: "event-core-worker",
		payload,
	};
}

export function createCortexWorker<TEvent extends RuntimeEvent = RuntimeEvent>(): RoleDefinition<TEvent> {
	return {
		name: "CortexWorker",
		match: () => false,
		run: () => {},
	};
}

export function createChatTitleWorker<TEvent extends RuntimeEvent = RuntimeEvent>(): RoleDefinition<TEvent> {
	return {
		name: "ChatTitleWorker",
		match: (event) => event.type === "turn_outcome" && event.payload.firstTurn === true,
		run: async ({ event, publish }) => {
			await publish(
				createEvent(event, "chat_title_generated", { title: String(event.payload.title ?? "New chat") }) as TEvent,
			);
		},
	};
}

export function createFileMentionResolverWorker<TEvent extends RuntimeEvent = RuntimeEvent>(): RoleDefinition<TEvent> {
	return {
		name: "FileMentionResolver",
		match: (event) => event.type === "user_message",
		run: async ({ event, publish }) => {
			const text = String(event.payload.text ?? "");
			const resolvedMentions = Array.from(text.matchAll(/@([^\s]+)/g)).map((match) => match[1]);
			await publish(createEvent(event, "user_message_ready", { ...event.payload, resolvedMentions }) as TEvent);
		},
	};
}

export function createProcessMetricsWorker<TEvent extends RuntimeEvent = RuntimeEvent>(): RoleDefinition<TEvent> {
	return {
		name: "ProcessMetricsWorker",
		match: (event) => event.type === "shell_process_ended",
		run: async ({ event, publish }) => {
			await publish(
				createEvent(event, "process_metrics_recorded", {
					processId: event.payload.processId ?? event.payload.toolCallId,
					durationMs: event.payload.durationMs ?? 0,
					exitCode: event.payload.exitCode ?? null,
					outputSize: event.payload.outputSize ?? 0,
					status: event.payload.status ?? "ended",
				}) as TEvent,
			);
		},
	};
}

export function createShellProcessWorker<TEvent extends RuntimeEvent = RuntimeEvent>(): RoleDefinition<TEvent> {
	return {
		name: "ShellProcessWorker",
		match: (event) => event.type === "shell_command_start",
		run: async ({ event, publish }) => {
			await publish(
				createEvent(event, "shell_process_started", {
					...event.payload,
					processId: event.payload.processId ?? event.id,
				}) as TEvent,
			);
		},
	};
}

export function createMemoryExtractionWorker<TEvent extends RuntimeEvent = RuntimeEvent>(): RoleDefinition<TEvent> {
	return {
		name: "MemoryExtractionWorker",
		match: (event) => event.type === "turn_outcome" && event.payload.sessionEnd === true,
		run: async ({ event, publish }) => {
			await publish(
				createEvent(event, "memory_extraction_started", {
					jobId: `memory-${event.id}`,
					sessionId: event.sessionId,
					cwd: event.payload.cwd,
					eventsPath: event.payload.eventsPath,
					memoryPath: event.payload.memoryPath,
					createdAt: new Date().toISOString(),
					attempts: 0,
					status: "pending",
				}) as TEvent,
			);
			// Memory extraction completion event closes the lifecycle
			await publish(
				createEvent(event, "memory_extraction_completed", {
					jobId: `memory-${event.id}`,
					sessionId: event.sessionId,
					status: "completed",
					completedAt: new Date().toISOString(),
				}) as TEvent,
			);
		},
	};
}

export function createDisplayWorker<TEvent extends RuntimeEvent = RuntimeEvent>(): RoleDefinition<TEvent> {
	return {
		name: "DisplayProjectionWorker",
		match: (event) => event.type === "message_chunk" || event.type === "thinking_chunk",
		run: ({ event, emitSignal }) => {
			emitSignal({
				type: "Display/updated",
				payload: {
					sourceEventId: event.id,
					chunkType: event.type,
					text: event.payload.text ?? event.payload.delta ?? "",
				},
			});
		},
	};
}

export function createBuiltinWorkers<TEvent extends RuntimeEvent = RuntimeEvent>(): Array<RoleDefinition<TEvent>> {
	return [
		createCortexWorker<TEvent>(),
		createChatTitleWorker<TEvent>(),
		createFileMentionResolverWorker<TEvent>(),
		createProcessMetricsWorker<TEvent>(),
		createShellProcessWorker<TEvent>(),
		createMemoryExtractionWorker<TEvent>(),
		createDisplayWorker<TEvent>(),
	];
}
