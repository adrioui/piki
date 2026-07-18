import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@piki/agent-core";
import {
	createOutboundMessagesProjection,
	createTaskWorkerProjection,
	createTaskWorkerRole,
	createWorkerActivityProjection,
} from "@piki/agent-core";
import {
	allowUnknownFieldsForStreaming,
	formatCorrectiveFeedback,
	type Model,
	registerSessionResourceCleanup,
	StreamingFieldParser,
	typeboxToStreamingSchema,
} from "@piki/ai";
import type { AssistantMessage } from "@piki/ai/compat";
import {
	createBuiltinExtendedProjections,
	createBuiltinWorkers,
	createCheckpointProjection,
	createGoalProjection,
	createTaskGraphProjection,
	createUserMessageResolutionProjection,
	DefaultEventSink,
	type EventEnvelope,
	ForkedProjectionStore,
	JsonlEventStore,
	type ProjectionDefinition,
	type RoleDefinition,
} from "@piki/event-core";
import {
	COORDINATOR_ON_IDLE,
	COORDINATOR_ON_SPAWN,
	JUSTIFICATION_TEMPLATES,
	JUSTIFICATION_VALUES,
	OBSERVER_PROMPT,
} from "@piki/roles";
import { Effect, ExecutionStrategy, Exit, Fiber, Queue, Scope } from "effect";
import { AgentModelResolver } from "./agent-model-resolver.ts";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import type { AgentSessionServices } from "./agent-session-services.ts";
import { buildConfigState, type ConfigState, refineConfigState } from "./ambient/config.ts";
import { resolvePreferredAuxModel, runAuxModelText } from "./aux-model.ts";
import { ForkRuntime } from "./fork-runtime.ts";
import { verifyGoal } from "./goal-verifier.ts";
import type { SessionEntry } from "./session-manager.ts";
import { createCheckpointId, createSnapshot, isGitRepo } from "./snapshot.ts";
import { TasteProfileStore, type TasteSignalType } from "./taste.ts";
import { type OverthinkingInfo, ThinkingGovernor } from "./thinking-governor.ts";
import { registerForkRuntime, unregisterForkRuntime } from "./tools/role-control-tool.ts";
import { WorkerExecutor } from "./worker-executor.ts";

type RuntimeEvent = EventEnvelope<string, Record<string, unknown>>;
interface OrchestratorWorkItem {
	task: () => Promise<void> | void;
	resolve: () => void;
	reject: (error: unknown) => void;
}

interface SessionOverviewProjection {
	sessionId: string;
	cwd: string;
	sessionFile?: string;
	sessionName?: string;
	lastActivityAt?: string;
	lastMessageRole?: string;
	lastUserText?: string;
	lastAssistantText?: string;
	lastAssistantStopReason?: string;
	lastToolNames: string[];
	currentModel?: {
		provider: string;
		id: string;
	};
	queue: {
		steering: number;
		followUp: number;
	};
	retryCount: number;
	messageCounts: {
		total: number;
		user: number;
		assistant: number;
		custom: number;
		toolResult: number;
	};
}

interface TranscriptProjection {
	recent: Array<{
		role: string;
		text: string;
		timestamp: string;
	}>;
}

interface SessionRuntimeMeta {
	version: 1;
	sessionId: string;
	cwd: string;
	sessionFile?: string;
	lastSequence: number;
	lastEventId?: string;
	lastActivityAt?: string;
	sessionName?: string;
	currentModel?: {
		provider: string;
		id: string;
	};
	queue: {
		steering: number;
		followUp: number;
	};
	messageCounts: SessionOverviewProjection["messageCounts"];
	tasteProfilePath?: string;
}

const ORCHESTRATORS = new Map<string, SessionOrchestrator>();
let CLEANUP_REGISTERED = false;
const MESSAGE_IDS = new WeakMap<object, string>();

function ensureCleanupRegistered(): void {
	if (CLEANUP_REGISTERED) return;
	registerSessionResourceCleanup((sessionId) => {
		if (sessionId) {
			const orchestrator = ORCHESTRATORS.get(sessionId);
			orchestrator?.dispose();
			ORCHESTRATORS.delete(sessionId);
			return;
		}
		for (const orchestrator of ORCHESTRATORS.values()) {
			orchestrator.dispose();
		}
		ORCHESTRATORS.clear();
	});
	CLEANUP_REGISTERED = true;
}

function readJsonFile<T>(path: string | undefined): T | undefined {
	if (!path || !existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function ensureParent(path: string | undefined): void {
	if (!path) return;
	const folder = dirname(path);
	if (!existsSync(folder)) {
		mkdirSync(folder, { recursive: true });
	}
}

function jsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Map) {
		return Object.fromEntries(value.entries());
	}
	return value;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part,
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function textFromMessage(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return textFromContent(message.content);
		case "assistant": {
			if (!Array.isArray(message.content)) return "";
			const parts: string[] = [];
			for (const part of message.content) {
				if (typeof part !== "object" || part === null || !("type" in part)) continue;
				if (part.type === "text" && "text" in part) {
					parts.push(String(part.text));
				} else if (part.type === "toolCall" && "name" in part) {
					const argsRaw = "arguments" in part ? JSON.stringify(part.arguments) : "";
					const args = argsRaw.length > 500 ? `${argsRaw.slice(0, 500)}[...truncated]` : argsRaw;
					parts.push(`[called tool: ${String(part.name)}(${args})]`);
				}
			}
			return parts.join("\n").trim();
		}
		case "toolResult":
			return `[tool result: ${message.toolName}] ${textFromContent(message.content)}`.trim();
		case "custom":
			return textFromContent(message.content);
		case "bashExecution":
			return message.command;
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return "";
	}
}

function runtimeTimestamp(): string {
	return new Date().toISOString();
}

function safeExec(cwd: string, command: string, args: string[]): string | undefined {
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
	} catch {
		return undefined;
	}
}

function parseGitStatusFiles(status: string | undefined): Map<string, string> {
	const files = new Map<string, string>();
	for (const line of status?.split("\n") ?? []) {
		if (line.length < 4) continue;
		const code = line.slice(0, 2).trim() || "modified";
		const rawPath = line.slice(3).trim();
		if (!rawPath) continue;
		const renameSeparator = " -> ";
		const filePath = rawPath.includes(renameSeparator)
			? rawPath.slice(rawPath.lastIndexOf(renameSeparator) + renameSeparator.length)
			: rawPath;
		files.set(filePath, code);
	}
	return files;
}

function collectGitState(cwd: string): Record<string, unknown> | undefined {
	if (!isGitRepo(cwd)) return undefined;
	return {
		branch: safeExec(cwd, "git", ["branch", "--show-current"]),
		status: safeExec(cwd, "git", ["status", "--short"]),
		recentCommits: safeExec(cwd, "git", ["log", "--oneline", "-5"])?.split("\n").filter(Boolean) ?? [],
	};
}

function collectFolderStructure(cwd: string): string {
	const tracked = safeExec(cwd, "git", ["ls-files"])?.split("\n").filter(Boolean) ?? [];
	const untracked =
		safeExec(cwd, "git", ["ls-files", "--others", "--exclude-standard"])?.split("\n").filter(Boolean) ?? [];
	const allFiles = [...tracked, ...untracked];
	if (allFiles.length <= 200) return allFiles.join("\n");
	// Knapsack: prioritize by depth (shallower = more important), then by file type
	const scored = allFiles.map((f) => {
		const depth = f.split("/").length;
		const ext = f.split(".").pop() ?? "";
		const isSource = /^(ts|js|py|go|rs|java|rb|cpp|c|json|yaml|yml|toml|md)$/.test(ext);
		const isConfig = /^(lock|toml|yaml|yml|json|ini|cfg)$/.test(ext);
		// Score: lower depth = higher priority, source files preferred
		const score = (20 - Math.min(depth, 20)) * 10 + (isSource ? 50 : 0) + (isConfig ? 20 : 0);
		return { path: f, score, cost: f.length + 1 };
	});
	scored.sort((a, b) => b.score - a.score);
	// Token budget: ~8000 chars for folder structure
	const budget = 8000;
	let used = 0;
	const selected: string[] = [];
	for (const item of scored) {
		if (used + item.cost > budget) break;
		selected.push(item.path);
		used += item.cost;
	}
	return selected.join("\n");
}

function collectAgentsFile(cwd: string): string | undefined {
	const path = join(cwd, "AGENTS.md");
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf-8").slice(0, 20000);
}

function isSafeSnapshotRoot(cwd: string): boolean {
	const resolvedHome = homedir();
	return cwd !== resolvedHome && cwd !== dirname(resolvedHome) && cwd !== "/";
}

function createRuntimeEvent(
	session: AgentSession,
	type: string,
	sequence: number,
	payload: Record<string, unknown>,
): RuntimeEvent {
	return {
		id: randomUUID(),
		stream: `session:${session.sessionId}`,
		sequence,
		type,
		timestamp: runtimeTimestamp(),
		sessionId: session.sessionId,
		payload,
	};
}

function createOverviewProjection(
	session: AgentSession,
): ProjectionDefinition<RuntimeEvent, SessionOverviewProjection> {
	return {
		name: "overview",
		initialState: {
			sessionId: session.sessionId,
			cwd: session.sessionManager.getCwd(),
			sessionFile: session.sessionFile,
			lastToolNames: [],
			queue: { steering: 0, followUp: 0 },
			retryCount: 0,
			messageCounts: {
				total: 0,
				user: 0,
				assistant: 0,
				custom: 0,
				toolResult: 0,
			},
			currentModel: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
		},
		reduce: (state, event) => {
			const next: SessionOverviewProjection = {
				...state,
				queue: { ...state.queue },
				messageCounts: { ...state.messageCounts },
				lastToolNames: [...state.lastToolNames],
			};

			if (event.type === "session.started") {
				next.sessionFile = event.payload.sessionFile as string | undefined;
				next.sessionName = event.payload.sessionName as string | undefined;
				next.currentModel =
					typeof event.payload.provider === "string" && typeof event.payload.modelId === "string"
						? { provider: event.payload.provider, id: event.payload.modelId }
						: next.currentModel;
			}

			if (event.type === "session.queue_updated") {
				next.queue = {
					steering: Number(event.payload.steering ?? 0),
					followUp: Number(event.payload.followUp ?? 0),
				};
			}

			if (event.type === "session.tool_started") {
				next.lastToolNames = [...next.lastToolNames, String(event.payload.toolName)];
			}

			if (event.type === "session.auto_retry_started") {
				next.retryCount += 1;
			}

			if (event.type === "session.message_recorded") {
				const role = String(event.payload.role ?? "");
				next.lastActivityAt = String(event.payload.timestamp ?? event.timestamp);
				next.lastMessageRole = role;
				next.messageCounts.total += 1;
				if (role === "user") {
					next.messageCounts.user += 1;
					next.lastUserText = String(event.payload.text ?? "");
				} else if (role === "assistant") {
					next.messageCounts.assistant += 1;
					next.lastAssistantText = String(event.payload.text ?? "");
					next.lastAssistantStopReason = event.payload.stopReason as string | undefined;
					next.currentModel =
						typeof event.payload.provider === "string" && typeof event.payload.modelId === "string"
							? { provider: event.payload.provider, id: event.payload.modelId }
							: next.currentModel;
				} else if (role === "custom") {
					next.messageCounts.custom += 1;
				} else if (role === "toolResult") {
					next.messageCounts.toolResult += 1;
				}
			}

			if (event.type === "session.agent_started") {
				next.lastToolNames = [];
			}

			if (event.type === "session.name_changed") {
				next.sessionName = event.payload.name as string | undefined;
			}

			return next;
		},
	};
}

function createTranscriptProjection(): ProjectionDefinition<RuntimeEvent, TranscriptProjection> {
	return {
		name: "transcript",
		initialState: { recent: [] },
		reduce: (state, event) => {
			if (event.type !== "session.message_recorded") {
				return state;
			}
			const customType = event.payload.customType as string | undefined;
			if (customType === "taste-profile" || customType === "advisor-message") {
				return state;
			}
			const text = String(event.payload.text ?? "").trim();
			if (text.length === 0) {
				return state;
			}
			const nextRecent = [
				...state.recent,
				{
					role: String(event.payload.role ?? "unknown"),
					text,
					timestamp: String(event.payload.timestamp ?? event.timestamp),
				},
			].slice(-24);
			return { recent: nextRecent };
		},
	};
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function getMessageId(message: AgentMessage): string {
	if ("id" in message && typeof message.id === "string") {
		return message.id;
	}
	if (typeof message === "object" && message !== null) {
		const existing = MESSAGE_IDS.get(message);
		if (existing) return existing;
		const id = randomUUID();
		MESSAGE_IDS.set(message, id);
		return id;
	}
	return randomUUID();
}

function messagePayload(message: AgentMessage, sessionId?: string): Record<string, unknown> {
	const base: Record<string, unknown> = {
		id: getMessageId(message),
		messageId: getMessageId(message),
		forkId: sessionId,
		destination: message.role === "assistant" ? { kind: "user" } : { kind: "coordinator" },
		role: message.role,
		text: textFromMessage(message),
		timestamp: "timestamp" in message ? message.timestamp : Date.now(),
	};
	if (message.role === "assistant") {
		return {
			...base,
			stopReason: message.stopReason,
			provider: message.provider,
			modelId: message.model,
		};
	}
	if (message.role === "custom") {
		return {
			...base,
			customType: message.customType,
			display: message.display,
		};
	}
	return base;
}

function maybeParseJson(text: string): Record<string, unknown> | undefined {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return undefined;
	try {
		return JSON.parse(match[0]) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function shouldEscalateHeuristically(overview: SessionOverviewProjection): {
	difficulty: boolean;
	churn: boolean;
	frustration: boolean;
} {
	const assistantText = overview.lastAssistantText?.toLowerCase() ?? "";
	const difficulty = overview.retryCount > 0 || overview.lastAssistantStopReason === "error";
	const churn = overview.lastToolNames.length >= 4;
	const frustration =
		overview.lastAssistantStopReason === "error" ||
		/(sorry|unable|can't|cannot|failed|issue|stuck)/i.test(assistantText);
	return { difficulty, churn, frustration };
}

type JustificationValue = keyof typeof JUSTIFICATION_TEMPLATES;

function pickJustification(assessment: {
	difficulty: boolean;
	churn: boolean;
	frustration: boolean;
}): JustificationValue {
	if (assessment.frustration) return "frustration";
	if (assessment.churn) return "churn";
	return "difficulty";
}

export class SessionOrchestrator {
	private readonly session: AgentSession;
	private readonly services: AgentSessionServices;
	private readonly sink: DefaultEventSink<RuntimeEvent>;
	private readonly tasteStore = new TasteProfileStore();
	private readonly metaPath?: string;
	private readonly projectionsPath?: string;
	private readonly controller = new AbortController();
	private readonly cleanupScope = Effect.runSync(Scope.make(ExecutionStrategy.sequential));
	private readonly existingEvents: RuntimeEvent[];
	private readonly forkRuntime: ForkRuntime;
	private readonly thinkingGovernor: ThinkingGovernor;
	private readonly forkedProjectionStore: ForkedProjectionStore<RuntimeEvent>;
	private configState: ConfigState;
	private sequence: number;
	private turnOutcomeCount: number;
	private lastEventId?: string;
	private unsubscribe?: () => void;
	private readonly eventQueue = Effect.runSync(Queue.bounded<OrchestratorWorkItem>(1024));
	private readonly eventConsumerFiber: Fiber.Fiber<never, unknown>;
	private previousGitStatus: string | undefined;
	private readonly streamingParsers = new Map<string, StreamingFieldParser>();
	private workerExecutor: WorkerExecutor | undefined;
	private errorPublishingDepth = 0;
	private disposed = false;

	/** Persist a durable report for every completed worker. */
	saveWorkerCompletionArtifact(result: {
		text: string;
		forkId: string;
		agentId: string;
		role: string;
		stopReason?: string;
	}): string | undefined {
		if (!result.text.trim()) return undefined;
		return this.session.scratchpad.save({
			title: `Worker ${result.role} finished report`,
			category: "reports",
			content: result.text,
			tags: ["worker-report"],
			metadata: {
				forkId: result.forkId,
				agentId: result.agentId,
				stopReason: result.stopReason ?? "finished",
			},
		});
	}

	constructor(session: AgentSession, services: AgentSessionServices) {
		this.session = session;
		this.services = services;
		const eventsPath =
			session.sessionManager.getSessionEventsFile() ??
			join(services.agentDir, "runtime-events", `${session.sessionId}.events.jsonl`);
		const store = new JsonlEventStore<RuntimeEvent>(eventsPath);
		this.metaPath = session.sessionManager.getSessionRuntimeMetaFile();
		this.projectionsPath = session.sessionManager.getSessionProjectionsFile();
		const existingMeta = readJsonFile<SessionRuntimeMeta>(this.metaPath);
		this.existingEvents = store.list();
		this.sequence = existingMeta?.lastSequence ?? 0;
		this.turnOutcomeCount = this.existingEvents.filter((event) => event.type === "turn_outcome").length;
		this.lastEventId = existingMeta?.lastEventId;
		this.forkedProjectionStore = new ForkedProjectionStore<RuntimeEvent>();
		this.sink = new DefaultEventSink<RuntimeEvent>(store, {
			projectionStore: this.forkedProjectionStore,
			onEventApplied: (event) => {
				this.sequence = Math.max(this.sequence, event.sequence);
				this.lastEventId = event.id;
				this.writeSidecars();
			},
		});
		this.forkedProjectionStore.registerGlobal(createOverviewProjection(session));
		this.forkedProjectionStore.registerGlobal(createTranscriptProjection());
		for (const projection of createBuiltinExtendedProjections<RuntimeEvent>()) {
			this.forkedProjectionStore.registerGlobal(projection);
		}
		this.forkedProjectionStore.registerGlobal(createGoalProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerGlobal(createTaskGraphProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerGlobal(createCheckpointProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerGlobal(createUserMessageResolutionProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerGlobal(createTaskWorkerProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerGlobal(createWorkerActivityProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerGlobal(createOutboundMessagesProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerForked(createGoalProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerForked(createTaskGraphProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerForked(createCheckpointProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerForked(createUserMessageResolutionProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerForked(createTaskWorkerProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerForked(createWorkerActivityProjection<RuntimeEvent>());
		this.forkedProjectionStore.registerForked(createOutboundMessagesProjection<RuntimeEvent>());
		if (this.existingEvents.length > 0) {
			this.sink.replay(this.existingEvents);
			const lastEvent = this.existingEvents[this.existingEvents.length - 1];
			this.sequence = Math.max(this.sequence, lastEvent?.sequence ?? 0);
			this.lastEventId = lastEvent?.id ?? this.lastEventId;
		}
		this.registerRoles();
		for (const worker of createBuiltinWorkers<RuntimeEvent>()) {
			this.sink.registerRole(worker);
		}
		this.thinkingGovernor = new ThinkingGovernor({
			onOverthinking: (info: OverthinkingInfo) => {
				void this.publishRuntimeEvent("session.overthinking_detected", {
					role: info.role,
					charCount: info.charCount,
					limit: info.limit,
					feedback: info.feedback,
				}).catch(() => {});
				// Defer abort to avoid racing with event publishing
				queueMicrotask(() => {
					void this.session
						.sendCustomMessage(
							{
								customType: "advisor-message",
								content: info.feedback,
								display: false,
							},
							undefined,
						)
						.catch(() => {});
					this.session.abort();
				});
			},
		});
		this.forkRuntime = new ForkRuntime({
			sessionId: session.sessionId,
			publish: (type, payload) => this.publishRuntimeEvent(type, payload),
			getSequence: () => this.sequence,
			resolveModel: (role: string) => {
				const resolver = new AgentModelResolver(this.services, this.session.getRoleModelOverrides());
				const model = resolver.resolve(role);
				return model ? { provider: model.provider, id: model.id } : undefined;
			},
		});
		registerForkRuntime(session.sessionId, this.forkRuntime);

		// Register WorkerExecutor unconditionally. Multi-agent workers are core runtime behavior.
		this.workerExecutor = new WorkerExecutor({
			resolveModel: (role: string) => {
				const resolver = new AgentModelResolver(this.services, this.session.getRoleModelOverrides());
				return resolver.resolve(role) as Model<string> | undefined;
			},
			// Reuse the leader's streamFn so workers resolve API keys, headers, env,
			// and retry settings exactly like the leader (it calls
			// modelRegistry.getApiKeyAndHeaders(model) per call). Without this,
			// workers fall back to bare streamSimple and throw for key-based providers.
			streamFn: this.session.agent.streamFn,
			getAllTools: () => this.session.getExecutableWorkerTools(),
			getAllSkills: () => this.session.resourceLoader.getSkills().skills,
			getProjectContext: () => collectFolderStructure(this.session.sessionManager.getCwd()),
			cwd: this.session.sessionManager.getCwd(),
			scratchpadPath: join(this.session.sessionManager.getCwd(), ".piki", "scratchpad"),
			getTranscript: () =>
				this.session.agent.state.messages
					.slice(-10)
					.map((message) => `${message.role}: ${textFromMessage(message)}`)
					.filter((line) => line.trim().length > 0)
					.join("\n\n"),
			publishEvent: (type, payload) => this.publishRuntimeEvent(type, payload),
			userRules: this.session.getUserPermissionRules(),
			disableShellSafeguards: this.session.disableShellSafeguards,
			disableCwdSafeguards: this.session.disableCwdSafeguards,
			getDefaultThinkingLevel: () => this.session.settingsManager.getDefaultThinkingLevel(),
			forkedProjectionStore: this.forkedProjectionStore,
			onWorkerFinished: (result) => {
				this.saveWorkerCompletionArtifact(result);
				const yielded = this.forkRuntime.takeYieldIntent(result.agentId);
				void this.publishRuntimeEvent("worker_finished", {
					agentId: result.agentId,
					forkId: result.forkId,
					role: result.role,
					result: result.text,
					stopReason: result.stopReason ?? "finished",
					yield: yielded,
				}).catch(() => {});
				void this.session
					.sendCustomMessage(
						{
							customType: "worker-result",
							content: `<worker_result role="${result.role}" stopReason="${result.stopReason ?? "finished"}">\n${result.text}\n</worker_result>`,
							display: true,
						},
						this.session.isStreaming ? undefined : { triggerTurn: true },
					)
					.catch(() => {});
				const guidance = COORDINATOR_ON_IDLE[result.role];
				if (guidance) {
					void this.session
						.sendCustomMessage(
							{
								customType: "coordinator-guidance",
								content: guidance,
								display: false,
							},
							undefined,
						)
						.catch(() => {});
				}
			},
			onWorkerError: (error) => {
				void this.publishRuntimeEvent("worker_error", {
					agentId: error.agentId,
					forkId: error.forkId,
					role: error.role,
					error: error.error,
					stopReason: "error",
				}).catch(() => {});
				void this.session
					.sendCustomMessage(
						{
							customType: "worker-error",
							content: `<worker_error role="${error.role}" workerId="${error.agentId}" stopReason="error">\n${error.error}\n</worker_error>`,
							display: true,
						},
						this.session.isStreaming ? undefined : { triggerTurn: true },
					)
					.catch(() => {});
			},
		});
		this.sink.registerRole(this.workerExecutor.asRole());
		this.eventConsumerFiber = this.startEventConsumer();
		this.registerCleanupFinalizers();
		// Seed the per-role config ambient from the fallback profile. It is
		// refined against the live model catalog in initialize() once the
		// orchestrator's own resolver/overrides are available.
		this.configState = buildConfigState();
	}

	private startEventConsumer(): Fiber.Fiber<never, unknown> {
		return Effect.runFork(
			Effect.forever(
				Effect.flatMap(Queue.take(this.eventQueue), (work) =>
					Effect.tryPromise(async () => {
						try {
							await work.task();
							work.resolve();
						} catch (error) {
							work.reject(error);
						}
					}),
				),
			),
		);
	}

	private registerCleanupFinalizers(): void {
		for (const finalizer of [
			() => this.controller.abort(),
			() => this.workerExecutor?.dispose(),
			() => this.sink.dispose(),
			() => {
				this.unsubscribe?.();
				this.unsubscribe = undefined;
			},
			() => unregisterForkRuntime(this.session.sessionId),
			() => this.thinkingGovernor.resetAll(),
			() => this.streamingParsers.clear(),
			() => {
				void Effect.runPromise(Queue.shutdown(this.eventQueue));
				void Effect.runPromise(Fiber.interrupt(this.eventConsumerFiber));
			},
		]) {
			Effect.runSync(Scope.addFinalizer(this.cleanupScope, Effect.sync(finalizer)));
		}
	}

	async initialize(): Promise<void> {
		// G-W4.4: once the session is attached, refine the per-role config
		// ambient against the live model catalog (resolved through the same
		// AgentModelResolver precedence used for workers/leader, including
		// runtime role-model overrides) so per-role caps reflect the actual
		// model context windows instead of the hardcoded fallback.
		this.configState = refineConfigState(this.configState, this.services, this.session.getRoleModelOverrides());

		this.unsubscribe = this.session.subscribe((event) => {
			void this.handleSessionEvent(event).catch((error) => {
				void this.publishRuntimeEvent("session.role_error", {
					eventType: event.type,
					error: error instanceof Error ? error.message : String(error),
				}).catch(() => {});
			});
		});

		if (!this.existingEvents.some((event) => event.type === "session.started")) {
			await this.publishRuntimeEvent("session.started", {
				sessionFile: this.session.sessionFile,
				sessionName: this.session.sessionManager.getSessionName(),
				provider: this.session.model?.provider,
				modelId: this.session.model?.id,
			});
		}
		if (!this.existingEvents.some((event) => event.type === "session_initialized")) {
			const cwd = this.session.sessionManager.getCwd();
			const currentUser = userInfo();
			await this.publishRuntimeEvent("session_initialized", {
				cwd,
				platform: platform(),
				shell: process.env.SHELL ?? "",
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				username: currentUser.username,
				fullName: currentUser.username,
				git: collectGitState(cwd),
				folderStructure: collectFolderStructure(cwd),
				agentsFile: collectAgentsFile(cwd),
				skills: [],
				scratchpadPath: join(cwd, ".piki", "scratchpad"),
			});
		}

		// Phase 6: Initialize autopilot state from env var
		if (
			process.env.PIKI_ENABLE_AUTOPILOT === "1" &&
			!this.existingEvents.some((e) => e.type === "autopilot_toggled")
		) {
			await this.publishRuntimeEvent("autopilot_toggled", {
				enabled: true,
				reason: "env_init",
			});
		}

		// Seed CLI --goal into the Goal projection at session init.
		// Guarded so resume/restore of a session that already has a goal does not re-inject.
		if (this.session.goal && !this.existingEvents.some((e) => e.type === "goal.injected")) {
			await this.publishRuntimeEventUnqueued("goal.injected", {
				goal: this.session.goal,
			});
		}

		const tasteProfile = this.tasteStore.renderInjectedProfile(this.session.sessionManager.getCwd());
		if (
			tasteProfile &&
			!this.session.messages.some((message) => message.role === "custom" && message.customType === "taste-profile")
		) {
			await this.session.sendCustomMessage(
				{
					customType: "taste-profile",
					content: tasteProfile,
					display: false,
				},
				undefined,
			);
			await this.publishRuntimeEvent("session.taste_profile_injected", {
				profilePath: this.tasteStore.getProfilePath(this.session.sessionManager.getCwd()),
			});
		} else {
			this.writeSidecars();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		Effect.runSync(Scope.close(this.cleanupScope, Exit.void));
	}

	/** Read-only view of the per-fork worker entries captured by the executor. */
	getForkEntries(): Map<string, SessionEntry[]> {
		return this.workerExecutor?.getForkEntries() ?? new Map();
	}

	/** Read-only view of the per-fork real fork metadata captured by the executor. */
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
		return this.workerExecutor?.getForkMeta() ?? new Map();
	}

	private createCheckpoint(kind: "turn-start" | "turn-end" | "manual" | "redo"):
		| {
				id: string;
				treeOID: string;
				kind: "turn-start" | "turn-end" | "manual" | "redo";
				timestamp: string;
		  }
		| undefined {
		const cwd = this.session.sessionManager.getCwd();
		if (!isSafeSnapshotRoot(cwd) || !isGitRepo(cwd)) return undefined;
		const id = createCheckpointId(kind);
		const treeOID = createSnapshot(cwd, this.session.sessionId, id);
		if (!treeOID) return undefined;
		return {
			id,
			treeOID,
			kind,
			timestamp: runtimeTimestamp(),
		};
	}

	private registerRoles(): void {
		const checkpointRole: RoleDefinition<RuntimeEvent> = {
			name: "checkpoint",
			match: (event) =>
				(event.type === "session.agent_started" || event.type === "session.agent_ended") &&
				event.payload.willRetry !== true,
			run: async ({ event }) => {
				if (event.type === "session.agent_started") {
					const checkpoint = this.createCheckpoint("turn-start");
					if (checkpoint) {
						await this.publishRuntimeEvent("checkpoint.created", checkpoint);
					}
					return;
				}
				const checkpoint = this.createCheckpoint("turn-end");
				if (checkpoint) {
					await this.publishRuntimeEvent("checkpoint.created", checkpoint);
				}
			},
		};

		const observerRole: RoleDefinition<RuntimeEvent> = {
			name: "observer",
			match: (event) => event.type === "session.agent_ended" && event.payload.willRetry !== true,
			run: async ({ projections, signal }) => {
				const overview = projections.get<SessionOverviewProjection>("overview");
				const transcript = projections.get<TranscriptProjection>("transcript");
				if (!overview) return;
				const heuristic = shouldEscalateHeuristically(overview);
				let assessment = {
					...heuristic,
					escalate: heuristic.difficulty || heuristic.churn || heuristic.frustration,
					justification: pickJustification(heuristic),
				};
				const model = resolvePreferredAuxModel(this.services, this.session.model);
				if (model && assessment.escalate && transcript) {
					try {
						const response = await runAuxModelText({
							services: this.services,
							model,
							sessionId: this.session.sessionId,
							signal,
							systemPrompt: [
								OBSERVER_PROMPT,
								"Assess whether the latest turn shows difficulty, churn, or frustration.",
								'Return a single JSON object with boolean keys "difficulty", "churn", "frustration", "escalate" and string key "justification".',
								'The justification value must be exactly one of: "difficulty", "churn", "frustration".',
							].join("\n"),
							messages: [
								{
									role: "user",
									content: [
										{
											type: "text",
											text: JSON.stringify(
												{
													overview,
													recentTranscript: transcript.recent.slice(-8),
												},
												null,
												2,
											),
										},
									],
									timestamp: Date.now(),
								},
							],
						});
						const parsed = maybeParseJson(response);
						if (parsed) {
							assessment = {
								difficulty: parsed.difficulty === true,
								churn: parsed.churn === true,
								frustration: parsed.frustration === true,
								escalate: parsed.escalate === true,
								justification: (JUSTIFICATION_VALUES as readonly string[]).includes(
									String(parsed.justification),
								)
									? (String(parsed.justification) as JustificationValue)
									: pickJustification(assessment),
							};
						}
					} catch {
						// Keep heuristic assessment
					}
				}
				const template = JUSTIFICATION_TEMPLATES[assessment.justification as JustificationValue];
				await this.publishRuntimeEvent("session.observer_assessed", {
					...assessment,
					message: assessment.escalate ? `<escalation_required>\n${template}\n</escalation_required>` : "pass",
				});
				// Persist the observer assessment as a session entry so it serializes
				// into the ATIF alpha22 export (S8 observer step). Leader path only —
				// worker forks publish a separate `observer_verdict` event and must not
				// double-count here.
				this.session.sessionManager.appendObserver(
					assessment.escalate,
					assessment.justification,
					assessment.escalate ? `<escalation_required>\n${template}\n</escalation_required>` : "pass",
				);
				await this.publishRuntimeEvent("observation", {
					difficulty: assessment.difficulty,
					churn: assessment.churn,
					frustration: assessment.frustration,
					escalate: assessment.escalate,
					justification: assessment.justification,
				});
			},
		};

		const advisorRole: RoleDefinition<RuntimeEvent> = {
			name: "advisor",
			match: (event) =>
				(event.type === "session.observer_assessed" && event.payload.escalate === true) ||
				event.type === "advisor_messaged" ||
				event.type === "escalation_requested",
			run: async ({ event, projections, signal }) => {
				const overview = projections.get<SessionOverviewProjection>("overview");
				if (!overview) return;
				const model = resolvePreferredAuxModel(this.services, this.session.model);
				if (!model) return;
				let advice = [
					"Re-read the latest user request and restate the exact next objective.",
					"Minimize new tool calls until you verify the last failing assumption.",
					"Prefer inspecting the most relevant file or error output before broad exploration.",
					"End the next turn with an explicit verification step.",
				].join("\n");
				try {
					advice = await runAuxModelText({
						services: this.services,
						model,
						sessionId: this.session.sessionId,
						signal,
						systemPrompt: [
							"You are an advisor for a coding agent.",
							"UPLIFT: improve the agent's strategy.",
							"PUSH: challenge premature completion.",
							"REFLECT: recall user requirements exactly.",
							"INTERCEPT: catch rabbit holes and redirect to evidence.",
							process.env.PIKI_ENABLE_AUTOPILOT === "1"
								? "Autopilot is enabled. If no <message_advisor> context exists, speak as the user."
								: "Autopilot is disabled. Include [AUTOPILOT_OFF] if the agent should not continue autonomously.",
							"Write 3 to 6 short imperative bullets addressed to the agent.",
							"Focus on the next best debugging or recovery steps.",
							"Do not explain your reasoning.",
						].join("\n"),
						messages: [
							{
								role: "user",
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												overview,
												assessment: event.payload,
												request: event.payload.message ?? event.payload.justification,
											},
											null,
											2,
										),
									},
								],
								timestamp: Date.now(),
							},
						],
					});
				} catch {
					// Keep fallback advice
				}
				await this.session.sendCustomMessage(
					{
						customType: "advisor-message",
						content: `<advisor>\n${advice.trim()}\n</advisor>`,
						display: false,
					},
					undefined,
				);
				// Phase 6: Check for [AUTOPILOT_OFF] marker in advisor response
				if (advice.includes("[AUTOPILOT_OFF]")) {
					await this.publishRuntimeEvent("autopilot_toggled", {
						enabled: false,
						reason: "advisor_off_marker",
					});
				}
				await this.publishRuntimeEvent("session.advisor_injected", {
					advice,
					reason: event.payload.justification,
				});
			},
		};

		const coordinatorSpawnRole: RoleDefinition<RuntimeEvent> = {
			name: "coordinator-spawn",
			match: (event) => event.type === "agent_created" && event.payload.mode === "spawn",
			concurrencyKey: () => "coordinator-spawn",
			run: async ({ event }) => {
				const role = String(event.payload.role ?? "");
				const guidance = COORDINATOR_ON_SPAWN[role];
				if (!guidance) return;
				await this.session.sendCustomMessage(
					{
						customType: "coordinator-guidance",
						content: guidance,
						display: false,
					},
					undefined,
				);
			},
		};

		const turnPassRole: RoleDefinition<RuntimeEvent> = {
			name: "turn-pass",
			match: (event) => event.type === "turn_passed",
			concurrencyKey: () => "turn-pass",
			run: async ({ event }) => {
				const message = String(event.payload.message ?? "pass");
				await this.session.sendCustomMessage(
					{
						customType: "turn-passed",
						content: `[Turn passed: ${message}]`,
						display: false,
					},
					undefined,
				);
			},
		};

		const taskDispatcherRole: RoleDefinition<RuntimeEvent> = {
			name: "task-dispatcher",
			match: (event) =>
				event.type === "task.assigned" ||
				(event.type === "task.created" && typeof event.payload.assignee === "string"),
			concurrencyKey: (event) => String(event.payload.assignee ?? event.payload.taskId ?? event.id),
			run: async ({ event }) => {
				const assignee = String(event.payload.assignee ?? "");
				if (!assignee) return;
				const title = String(event.payload.title ?? event.payload.taskId ?? "");
				const description = String(event.payload.description ?? "");
				const message = description ? `Task assigned: ${title}\n\n${description}` : `Task assigned: ${title}`;
				await this.forkRuntime.messageWorker({
					workerId: assignee,
					message,
				});
			},
		};

		const goalCompletionRole: RoleDefinition<RuntimeEvent> = {
			name: "goal-completion-verifier",
			match: (event) => event.type === "goal.completion_requested",
			concurrencyKey: () => "goal-completion-verifier",
			run: async ({ event, projections }) => {
				const goal = projections.get<{ goal: string | null }>("Goal");
				const transcript = projections.get<TranscriptProjection>("transcript");
				const goalText = String(event.payload.goalText ?? goal?.goal ?? "");
				if (!goalText || !transcript) return;
				const verdict = await verifyGoal(
					{
						goalText,
						transcript: transcript.recent,
						toolResults: [],
						fileChanges: [],
						agentClaim: "incomplete",
					},
					this.services,
					this.session.model,
				);
				await this.publishRuntimeEvent(verdict.verdict === "finished" ? "goal.finished" : "goal.incomplete", {
					goal: goalText,
					evidence: String(event.payload.evidence ?? verdict.evidence),
					source: verdict.source,
					verdict: verdict.verdict,
				});
			},
		};

		this.sink.registerRole(checkpointRole);
		this.sink.registerRole(observerRole);
		this.sink.registerRole(advisorRole);
		this.sink.registerRole(coordinatorSpawnRole);
		this.sink.registerRole(turnPassRole);
		this.sink.registerRole(taskDispatcherRole);
		this.sink.registerRole(goalCompletionRole);
		this.sink.registerRole(createTaskWorkerRole<RuntimeEvent>());
	}

	private async handleSessionEvent(event: AgentSessionEvent): Promise<void> {
		await this.enqueue(async () => {
			if (this.controller.signal.aborted) return;
			const runtimeEvents = this.mapSessionEvent(event);
			for (const runtimeEvent of runtimeEvents) {
				await this.publishInternal(runtimeEvent);
			}
			if (event.type === "turn_end") {
				await this.handleTurnEndPostProcessing(event);
			}
			if (event.type === "message_start" && event.message.role === "user") {
				await this.handleGoalInjection(event);
			}
			if (event.type === "message_update") {
				const update = event.assistantMessageEvent as {
					type?: string;
					delta?: string;
				};
				if (update.type === "thinking_delta" && update.delta) {
					this.thinkingGovernor.recordDelta("leader", update.delta);
				}
				if (update.type === "toolcall_delta" && update.delta) {
					this.onToolCallDelta(event);
				}
				if (update.type === "toolcall_end") {
					const ended = event.assistantMessageEvent as { toolCall?: { id?: string } };
					if (ended.toolCall?.id) {
						this.streamingParsers.delete(ended.toolCall.id);
					}
				}
			}
			if (event.type === "agent_end") {
				this.streamingParsers.clear();
				if (!event.willRetry) {
					this.thinkingGovernor.reset("leader");
				}
			}
		});
	}

	/**
	 * Mid-stream tool call validation sidecar.
	 * Pushes toolcall_delta to a per-tool-call StreamingFieldParser and aborts on failure.
	 */
	private onToolCallDelta(event: AgentSessionEvent & { type: "message_update" }): void {
		const message = event.message as { content?: Array<{ type: string; id?: string; name?: string }> };
		const update = event.assistantMessageEvent as { contentIndex?: number };
		const contentIndex = update.contentIndex ?? 0;
		const content = message?.content?.[contentIndex];
		if (!content || content.type !== "toolCall" || !content.id || !content.name) return;

		const toolCallId = content.id;
		const toolName = content.name;

		let parser = this.streamingParsers.get(toolCallId);
		if (!parser) {
			const tool = this.session.agent.state.tools.find((entry) => entry.name === toolName);
			if (!tool) return;
			let schema: ReturnType<typeof typeboxToStreamingSchema>;
			try {
				schema = typeboxToStreamingSchema(tool.parameters);
				if (typeof tool.prepareArguments === "function") {
					schema = allowUnknownFieldsForStreaming(schema);
				}
			} catch {
				return;
			}
			parser = new StreamingFieldParser(schema);
			this.streamingParsers.set(toolCallId, parser);
		}

		const delta = (event.assistantMessageEvent as { delta?: string }).delta ?? "";
		parser.push(delta);

		if (!parser.valid) {
			const feedback = formatCorrectiveFeedback(parser.getValidationState());
			this.session.abortCurrentStream("tool_validation", feedback);
			void this.publishRuntimeEvent("session.tool_validation_failed", {
				toolName,
				toolCallId,
				errors: [parser.validationIssue ?? "Unknown validation error"],
			}).catch(() => {});
			this.streamingParsers.clear();
		}
	}

	/**
	 * Inject a goal when a user message is received and no goal is active.
	 * The user's message text becomes the goal text.
	 */
	private async handleGoalInjection(event: AgentSessionEvent & { type: "message_start" }): Promise<void> {
		const projections = this.sink.projections();
		const goal = projections.get<{ status: string; goal: string | null }>("Goal");
		if (goal?.status === "idle" || goal?.status === "finished" || goal?.status === "incomplete") {
			const goalText = textFromMessage(event.message);
			if (goalText.length > 0) {
				await this.publishRuntimeEventUnqueued("goal.injected", {
					goal: goalText,
				});
			}
		}
	}

	/**
	 * Post-processing after a turn ends: goal verification (Phase 1)
	 * and taste signal recording (Phase 5).
	 */
	private async handleTurnEndPostProcessing(event: AgentSessionEvent & { type: "turn_end" }): Promise<void> {
		const projections = this.sink.projections();
		const goal = projections.get<{ status: string; goal: string | null }>("Goal");
		const overview = projections.get<SessionOverviewProjection>("overview");
		const transcript = projections.get<TranscriptProjection>("transcript");

		// Phase 1: Goal verification
		if (goal?.status === "started" && goal.goal && transcript) {
			try {
				const verdict = await verifyGoal(
					{
						goalText: goal.goal,
						transcript: transcript.recent,
						toolResults: event.toolResults.map((r) => ({
							toolName: r.toolName,
							result: r.content,
							isError: r.isError,
						})),
						fileChanges: [],
						agentClaim:
							event.message.role === "assistant" &&
							"stopReason" in event.message &&
							event.message.stopReason === "stop"
								? "finished"
								: "incomplete",
					},
					this.services,
					this.session.model,
				);
				await this.publishRuntimeEventUnqueued(
					verdict.verdict === "finished" ? "goal.finished" : "goal.incomplete",
					{
						goal: goal.goal,
						evidence: verdict.evidence,
						source: verdict.source,
						verdict: verdict.verdict,
					},
				);
			} catch (err) {
				console.error("[orchestrator] Goal verification failed:", err instanceof Error ? err.message : err);
			}
		}

		// Phase 5: Taste signal recording
		if (overview) {
			const cwd = this.session.sessionManager.getCwd();
			const currentGitStatus = isGitRepo(cwd) ? safeExec(cwd, "git", ["status", "--short"]) : undefined;
			const diffSummary = isGitRepo(cwd) ? safeExec(cwd, "git", ["diff", "--stat"]) : undefined;
			const signalType = this.classifyTasteSignal(currentGitStatus);
			this.tasteStore.recordObservation({
				timestamp: runtimeTimestamp(),
				sessionId: this.session.sessionId,
				cwd,
				userText: overview.lastUserText,
				assistantText: overview.lastAssistantText,
				toolNames: overview.lastToolNames,
				retryCount: overview.retryCount,
				stopReason: overview.lastAssistantStopReason,
				model: overview.currentModel,
				signalType,
				changedFiles: currentGitStatus?.split("\n").filter(Boolean) ?? [],
				diffSummary,
			});
			this.previousGitStatus = currentGitStatus;
		}

		// Publish error_resolved when a turn succeeds after a previous error
		if (overview && overview.retryCount === 0 && overview.lastAssistantStopReason !== "error") {
			const errorState = this.sink.projections().get<{ errors: unknown[]; lastError: unknown }>("Error");
			if (errorState?.lastError) {
				await this.publishRuntimeEventUnqueued("error_resolved", {});
			}
		}
	}

	/**
	 * Classify the taste signal type by comparing the current git status
	 * with the previous turn's git status.
	 */
	private classifyTasteSignal(currentStatus: string | undefined): TasteSignalType {
		if (this.previousGitStatus === undefined) return "observe";
		if (!currentStatus && !this.previousGitStatus) return "observe";
		if (!currentStatus && this.previousGitStatus) return "reject";
		if (currentStatus && !this.previousGitStatus) return "accept";
		if (currentStatus === this.previousGitStatus) return "accept";

		const previousFiles = parseGitStatusFiles(this.previousGitStatus);
		const currentFiles = parseGitStatusFiles(currentStatus);
		let preservedFiles = 0;
		let editedFiles = 0;
		for (const [filePath, previousCode] of previousFiles) {
			const currentCode = currentFiles.get(filePath);
			if (currentCode === undefined) continue;
			if (currentCode === previousCode) preservedFiles++;
			else editedFiles++;
		}
		if (editedFiles > 0) return "edit";
		if (preservedFiles > 0) return "accept";
		return "edit";
	}

	/**
	 * Toggle autopilot mode (Phase 6). Publishes an autopilot_toggled event.
	 */
	async toggleAutopilot(enabled: boolean): Promise<void> {
		await this.publishRuntimeEvent("autopilot_toggled", { enabled });
	}

	/**
	 * Get the fork runtime instance (for external access).
	 */
	getForkRuntime(): ForkRuntime {
		return this.forkRuntime;
	}

	private mapSessionEvent(event: AgentSessionEvent): RuntimeEvent[] {
		const events: RuntimeEvent[] = [];
		const next = (type: string, payload: Record<string, unknown>) => {
			this.sequence += 1;
			events.push(createRuntimeEvent(this.session, type, this.sequence, payload));
		};

		switch (event.type) {
			case "agent_start":
				next("session.agent_started", {});
				next("agent_created", {
					forkId: this.session.sessionId,
					parentForkId: null,
					agentId: this.session.sessionId,
					name: "leader",
					role: "leader",
					context: "",
					mode: "continue",
					message: "Session leader started",
					model: this.session.model
						? { provider: this.session.model.provider, id: this.session.model.id }
						: undefined,
				});
				break;
			case "agent_end": {
				const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
				next("session.agent_ended", {
					willRetry: event.willRetry,
					stopReason: lastAssistant?.stopReason,
				});
				next("agent_finished", {
					agentId: this.session.sessionId,
					forkId: this.session.sessionId,
					willRetry: event.willRetry,
					stopReason: lastAssistant?.stopReason,
				});
				break;
			}
			case "turn_start":
				next("turn_started", {
					turnId: randomUUID(),
					chainId: this.session.sessionId,
				});
				break;
			case "turn_end":
				this.turnOutcomeCount += 1;
				next("turn_outcome", {
					result: "finished",
					firstTurn: this.turnOutcomeCount === 1,
					messageRole: event.message.role,
					toolResultCount: event.toolResults.length,
					stopReason: (event.message as { stopReason?: string }).stopReason,
					agentId: this.session.sessionId,
				});
				break;
			case "skill_activated":
				next("skill_activated", {
					skillName: event.skillName,
					skillPath: event.skillPath,
					hasArgs: event.hasArgs,
				});
				break;
			case "message_start":
				next(
					event.message.role === "user" ? "user_message" : "message_start",
					messagePayload(event.message, this.session.sessionId),
				);
				break;
			case "message_update": {
				const update = event.assistantMessageEvent as {
					type?: string;
					delta?: string;
					content?: string;
				};
				if (update.type === "thinking_start") next("thinking_start", {});
				else if (update.type === "thinking_delta") next("thinking_chunk", { text: update.delta ?? "" });
				else if (update.type === "thinking_end") next("thinking_end", { text: update.content ?? "" });
				else
					next("message_chunk", {
						id: getMessageId(event.message),
						messageId: getMessageId(event.message),
						forkId: this.session.sessionId,
						destination: { kind: "user" },
						text: update.delta ?? update.content ?? textFromMessage(event.message),
					});
				break;
			}
			case "message_end": {
				const payload = messagePayload(event.message, this.session.sessionId);
				next("session.message_recorded", payload);
				next("message_end", payload);
				if (event.message.role === "assistant") {
					const usage = (
						event.message as {
							usage?: {
								input?: number;
								output?: number;
								cacheRead?: number;
								cacheWrite?: number;
								totalTokens?: number;
								cost?: {
									total?: number;
									input?: number;
									output?: number;
									cacheRead?: number;
									cacheWrite?: number;
								};
							};
						}
					).usage;
					if (usage) {
						next("usage_recorded", {
							inputTokens: usage.input ?? 0,
							outputTokens: usage.output ?? 0,
							cacheReadTokens: usage.cacheRead ?? 0,
							cacheWriteTokens: usage.cacheWrite ?? 0,
							totalTokens: usage.totalTokens ?? 0,
							cost: usage.cost?.total ?? 0,
							costInput: usage.cost?.input ?? 0,
							costOutput: usage.cost?.output ?? 0,
							costCacheRead: usage.cost?.cacheRead ?? 0,
							costCacheWrite: usage.cost?.cacheWrite ?? 0,
						});
					} else {
						next("usage_recorded", {
							inputTokens: 0,
							outputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							totalTokens: 0,
							cost: 0,
							missingReason:
								(event.message as { stopReason?: string }).stopReason === "error"
									? "stream_failed_before_usage"
									: "usage_chunk_never_arrived",
						});
					}
				}
				break;
			}
			case "tool_execution_start":
				next("session.tool_started", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
				});
				next("tool_event", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					status: "started",
				});
				if (event.toolName === "bash") {
					next("shell_command_start", {
						processId: event.toolCallId,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						command: typeof event.args?.command === "string" ? event.args.command : "",
					});
					next("user_bash_command", {
						command: typeof event.args?.command === "string" ? event.args.command : "",
						toolCallId: event.toolCallId,
					});
				}
				break;
			case "tool_execution_end":
				next("session.tool_ended", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
				});
				next("tool_event", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					status: event.isError ? "error" : "completed",
				});
				if (event.toolName === "bash") {
					next("shell_process_ended", {
						processId: event.toolCallId,
						toolCallId: event.toolCallId,
						status: event.isError ? "error" : "completed",
						outputSize: JSON.stringify(event.result ?? {}).length,
					});
				}
				break;
			case "queue_update":
				next("session.queue_updated", {
					steering: event.steering.length,
					followUp: event.followUp.length,
				});
				break;
			case "session_info_changed":
				next("session.name_changed", {
					name: event.name,
				});
				break;
			case "session_shutdown":
				next("session.shutdown", {
					reason: event.reason,
				});
				break;
			case "thinking_level_changed":
				next("session.thinking_level_changed", {
					level: event.level,
				});
				break;
			case "compaction_start":
				next("session.compaction_started", {
					reason: event.reason,
				});
				next("compaction_started", {
					reason: event.reason,
				});
				next("compaction_prepared", {
					reason: event.reason,
				});
				break;
			case "compaction_end":
				next("session.compaction_ended", {
					reason: event.reason,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				});
				next("compaction_ended", {
					reason: event.reason,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				});
				next("compaction_injected", {
					reason: event.reason,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				});
				break;
			case "auto_retry_start":
				next("session.auto_retry_started", {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				});
				next("error_raised", {
					errorMessage: event.errorMessage,
					attempt: event.attempt,
				});
				break;
			case "auto_retry_end":
				next("session.auto_retry_ended", {
					attempt: event.attempt,
					success: event.success,
					finalError: event.finalError,
				});
				break;
			default:
				if (process.env.PIKI_DEBUG === "1") {
					console.debug(`[orchestrator] Unhandled session event: ${event.type}`);
				}
				break;
		}

		return events;
	}

	async publishRuntimeEvent(type: string, payload: Record<string, unknown>): Promise<void> {
		await this.enqueue(async () => {
			if (this.controller.signal.aborted) return;
			await this.publishRuntimeEventUnqueued(type, payload);
		});
	}

	private async publishRuntimeEventUnqueued(type: string, payload: Record<string, unknown>): Promise<void> {
		if (this.controller.signal.aborted) return;
		this.sequence += 1;
		await this.publishInternal(createRuntimeEvent(this.session, type, this.sequence, payload));
	}

	private async publishInternal(event: RuntimeEvent): Promise<void> {
		await this.sink.publish(event);
		this.session.emitRuntimeEvent(event);
		void this.sink.waitForIdle().catch((error) => {
			if (this.errorPublishingDepth < 3) {
				this.errorPublishingDepth++;
				void this.publishRuntimeEvent("session.role_error", {
					eventType: event.type,
					error: error instanceof Error ? error.message : String(error),
				}).finally(() => this.errorPublishingDepth--);
			}
		});
	}

	private writeSidecars(): void {
		ensureParent(this.metaPath);
		ensureParent(this.projectionsPath);
		const projections = this.sink.projections();
		const overview = projections.get<SessionOverviewProjection>("overview");
		const snapshots = typeof projections.snapshots === "function" ? projections.snapshots() : [];
		const meta: SessionRuntimeMeta = {
			version: 1,
			sessionId: this.session.sessionId,
			cwd: this.session.sessionManager.getCwd(),
			sessionFile: this.session.sessionFile,
			lastSequence: this.sequence,
			lastEventId: this.lastEventId,
			lastActivityAt: overview?.lastActivityAt,
			sessionName: overview?.sessionName,
			currentModel: overview?.currentModel,
			queue: overview?.queue ?? { steering: 0, followUp: 0 },
			messageCounts: overview?.messageCounts ?? {
				total: 0,
				user: 0,
				assistant: 0,
				custom: 0,
				toolResult: 0,
			},
			tasteProfilePath: this.tasteStore.getProfilePath(this.session.sessionManager.getCwd()),
		};
		if (this.metaPath) {
			writeFileSync(this.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
		}
		if (this.projectionsPath) {
			writeFileSync(this.projectionsPath, `${JSON.stringify(snapshots, jsonReplacer, 2)}\n`);
		}
	}

	private async enqueue(task: () => Promise<void> | void): Promise<void> {
		if (this.disposed) return;
		await new Promise<void>((resolve, reject) => {
			Effect.runPromise(Queue.offer(this.eventQueue, { task, resolve, reject })).catch(reject);
		});
	}
}

export async function attachSessionOrchestrator(
	session: AgentSession,
	services: AgentSessionServices,
): Promise<SessionOrchestrator> {
	ensureCleanupRegistered();
	ORCHESTRATORS.get(session.sessionId)?.dispose();
	const orchestrator = new SessionOrchestrator(session, services);
	ORCHESTRATORS.set(session.sessionId, orchestrator);
	await orchestrator.initialize();
	return orchestrator;
}

/** Read-only accessor for the per-fork worker entries captured by a session's
 * WorkerExecutor. Used by `AgentSession.getForkEntries()` to populate ATIF
 * subagent_trajectories without holding a direct orchestrator reference. */
export function getForkEntriesForSession(sessionId: string): Map<string, SessionEntry[]> {
	return ORCHESTRATORS.get(sessionId)?.getForkEntries() ?? new Map();
}

/** Read-only accessor for the per-fork real fork metadata captured by a session's
 * WorkerExecutor. Used by `AgentSession.getForkMeta()` to populate ATIF
 * spawn-step real `agentId`/`role`/`taskId`/`mode`/`message` without holding a
 * direct orchestrator reference. Mirrors `getForkEntriesForSession`. */
export function getForkMetaForSession(sessionId: string): Map<
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
	return ORCHESTRATORS.get(sessionId)?.getForkMeta() ?? new Map();
}
