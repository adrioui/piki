import { DEFAULT_CONTEXT_LIMIT_POLICY } from "./constants.ts";
import { createSignal, type EventEnvelope, type ProjectionDefinition, type Signal } from "./types.ts";

type Bag = Record<string, unknown>;

function payload(event: EventEnvelope): Bag {
	return (event.payload ?? {}) as Bag;
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function append<T>(items: readonly T[], item: T, limit = 200): T[] {
	return [...items, item].slice(-limit);
}

export interface SessionContextState {
	cwd: string;
	platform: string;
	shell: string;
	timezone: string;
	username: string;
	fullName?: string;
	git?: unknown;
	folderStructure?: string;
	agentsFile?: string;
	skills: Array<{ name: string; description?: string; path?: string }>;
	scratchpadPath?: string;
}

export function createSessionContextProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	SessionContextState
> {
	return {
		name: "SessionContext",
		reads: [],
		writes: [],
		initialState: (): SessionContextState => ({
			cwd: "",
			platform: "",
			shell: "",
			timezone: "",
			username: "",
			skills: [],
		}),
		reduce: (state, event) => {
			if (event.type !== "session_initialized") return state;
			return { ...state, ...(payload(event) as Partial<SessionContextState>) };
		},
	};
}

export interface ConversationState {
	messages: Array<{ role: string; text: string; timestamp: string; id?: string }>;
	turnCount: number;
}

export function createConversationProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	ConversationState
> {
	return {
		name: "Conversation",
		reads: ["SessionContext"],
		writes: [],
		initialState: (): ConversationState => ({ messages: [], turnCount: 0 }),
		reduce: (state, event) => {
			const p = payload(event);
			if (event.type === "turn_started") return { ...state, turnCount: state.turnCount + 1 };
			if (["user_message", "user_message_ready", "message_start", "message_end"].includes(event.type)) {
				const role = str(p.role, event.type.startsWith("user_") ? "user" : "assistant");
				const text = str(p.text);
				if (!text && event.type !== "message_start") return state;
				if (event.type === "user_message_ready") {
					const previous = state.messages.at(-1);
					if (
						previous?.role === role &&
						previous.text === text &&
						(!previous.id || previous.id === str(p.messageId))
					) {
						return state;
					}
				}
				return {
					...state,
					messages: append(state.messages, { role, text, timestamp: event.timestamp, id: str(p.messageId) }, 500),
				};
			}
			return state;
		},
	};
}

export interface AgentRoutingState {
	activeAgent: string | null;
	forkTree: Map<string, string | null>;
}

export const AgentRoutingSignals = {
	agentSpawned: createSignal("AgentRouting/agentSpawned", "A worker agent was spawned"),
};

export function createAgentRoutingProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	AgentRoutingState
> {
	return {
		name: "AgentRouting",
		reads: ["Conversation"],
		writes: [],
		signals: [AgentRoutingSignals.agentSpawned],
		initialState: (): AgentRoutingState => ({ activeAgent: null, forkTree: new Map() }),
		reduce: (state, event) => {
			const p = payload(event);
			if (event.type === "agent_created") {
				const forkId = str(p.forkId, str(p.agentId));
				const forkTree = new Map(state.forkTree);
				if (forkId) forkTree.set(forkId, p.parentForkId ? str(p.parentForkId) : null);
				return { activeAgent: str(p.agentId, forkId || state.activeAgent || ""), forkTree };
			}
			if (event.type === "agent_finished") return { ...state, activeAgent: null };
			return state;
		},
		extractSignals: (_state, event): Signal[] =>
			event.type === "agent_created"
				? [{ type: AgentRoutingSignals.agentSpawned.type, payload: payload(event) }]
				: [],
	};
}

export interface DisplayState {
	visibleMessages: Array<{ kind: string; text: string; timestamp: string }>;
	scrollPosition: number;
}

export function createDisplayProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	DisplayState
> {
	return {
		name: "Display",
		reads: ["Conversation"],
		writes: [],
		initialState: (): DisplayState => ({ visibleMessages: [], scrollPosition: 0 }),
		reduce: (state, event) => {
			if (event.type !== "message_chunk" && event.type !== "thinking_chunk") return state;
			const text = str(payload(event).text, str(payload(event).delta));
			return {
				...state,
				visibleMessages: append(
					state.visibleMessages,
					{ kind: event.type, text, timestamp: event.timestamp },
					1000,
				),
			};
		},
	};
}

export interface AutopilotState {
	enabled: boolean;
	timeline: Array<{ type: string; timestamp: string; payload: unknown }>;
}

export function createAutopilotStateProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	AutopilotState
> {
	return {
		name: "AutopilotState",
		reads: [],
		writes: [],
		initialState: (): AutopilotState => ({ enabled: false, timeline: [] }),
		reduce: (state, event) => {
			if (event.type === "autopilot_toggled") return { ...state, enabled: bool(payload(event).enabled) };
			if (["user_message", "observation", "user_bash_command"].includes(event.type)) {
				return {
					...state,
					timeline: append(state.timeline, {
						type: event.type,
						timestamp: event.timestamp,
						payload: event.payload,
					}),
				};
			}
			return state;
		},
	};
}

export interface PermissionPolicyState {
	allowedTools: Set<string>;
	deniedTools: Set<string>;
	pending: Bag[];
}

export function createPermissionPolicyProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	PermissionPolicyState
> {
	return {
		name: "PermissionPolicy",
		reads: [],
		writes: [],
		initialState: (): PermissionPolicyState => ({ allowedTools: new Set(), deniedTools: new Set(), pending: [] }),
		reduce: (state, event) => {
			const p = payload(event);
			const tool = str(p.toolName);
			if (event.type === "permission_requested") return { ...state, pending: append(state.pending, p, 100) };
			if (event.type === "permission_granted") {
				const allowedTools = new Set(state.allowedTools);
				if (tool) allowedTools.add(tool);
				return { ...state, allowedTools, pending: state.pending.filter((item) => item.requestId !== p.requestId) };
			}
			if (event.type === "permission_denied") {
				const deniedTools = new Set(state.deniedTools);
				if (tool) deniedTools.add(tool);
				return { ...state, deniedTools, pending: state.pending.filter((item) => item.requestId !== p.requestId) };
			}
			return state;
		},
	};
}

export interface TurnState {
	turnId: string | null;
	chainId: string | null;
	status: "idle" | "running" | "finished";
}

export const TurnSignals = {
	started: createSignal("Turn/started", "A turn started"),
	finished: createSignal("Turn/finished", "A turn finished"),
};

export function createTurnProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	TurnState
> {
	return {
		name: "Turn",
		reads: ["Conversation"],
		writes: [],
		signals: [TurnSignals.started, TurnSignals.finished],
		initialState: (): TurnState => ({ turnId: null, chainId: null, status: "idle" }),
		reduce: (state, event) => {
			const p = payload(event);
			if (event.type === "turn_started")
				return { turnId: str(p.turnId), chainId: str(p.chainId), status: "running" };
			if (event.type === "turn_outcome") return { ...state, status: "finished" };
			return state;
		},
		extractSignals: (state, event): Signal[] =>
			event.type === "turn_started"
				? [{ type: TurnSignals.started.type, payload: state }]
				: event.type === "turn_outcome"
					? [{ type: TurnSignals.finished.type, payload: state }]
					: [],
	};
}

export interface ForkState {
	forks: Map<string, Bag>;
	parentForkId: string | null;
}

export const ForkSignals = {
	created: createSignal("Fork/created", "A fork was created"),
};

export function createForkProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	ForkState
> {
	return {
		name: "Fork",
		reads: ["AgentRouting"],
		writes: [],
		signals: [ForkSignals.created],
		initialState: (): ForkState => ({ forks: new Map(), parentForkId: null }),
		reduce: (state, event) => {
			const p = payload(event);
			if (event.type === "fork_cleaned") {
				const forkId = str(p.forkId, str(p.agentId));
				if (!forkId || !state.forks.has(forkId)) return state;
				const forks = new Map(state.forks);
				forks.delete(forkId);
				return { ...state, forks };
			}
			if (event.type !== "agent_created") return state;
			const forkId = str(p.forkId, str(p.agentId));
			const forks = new Map(state.forks);
			if (forkId) forks.set(forkId, p);
			return { forks, parentForkId: p.parentForkId ? str(p.parentForkId) : state.parentForkId };
		},
		extractSignals: (_state, event): Signal[] =>
			event.type === "agent_created" ? [{ type: ForkSignals.created.type, payload: payload(event) }] : [],
	};
}

export interface AgentStatusState {
	agents: Map<string, { role?: string; status: string; taskId?: string }>;
}

export function createAgentStatusProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	AgentStatusState
> {
	return {
		name: "AgentStatus",
		reads: ["Fork"],
		writes: [],
		initialState: (): AgentStatusState => ({ agents: new Map() }),
		reduce: (state, event) => {
			const p = payload(event);
			const id = str(p.agentId);
			if (!id) return state;
			const agents = new Map(state.agents);
			if (event.type === "agent_created")
				agents.set(id, { role: str(p.role), status: "running", taskId: str(p.taskId) });
			if (event.type === "agent_finished") agents.set(id, { ...(agents.get(id) ?? {}), status: "finished" });
			if (event.type === "task_assigned" || event.type === "task.assigned") {
				agents.set(id, { ...(agents.get(id) ?? {}), status: "working", taskId: str(p.taskId) });
			}
			return { agents };
		},
	};
}

export interface ShellProcessState {
	processes: Map<
		string,
		{ command?: string; status: string; exitCode?: number; durationMs?: number; outputSize?: number }
	>;
}

export function createShellProcessProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	ShellProcessState
> {
	return {
		name: "ShellProcess",
		reads: [],
		writes: [],
		initialState: (): ShellProcessState => ({ processes: new Map() }),
		reduce: (state, event) => {
			const p = payload(event);
			const id = str(p.processId, str(p.toolCallId));
			if (!id) return state;
			const processes = new Map(state.processes);
			if (event.type === "shell_process_started") {
				processes.set(id, { command: str(p.command), status: "running" });
			}
			if (event.type === "shell_process_ended") {
				processes.set(id, {
					...(processes.get(id) ?? {}),
					status: "ended",
					exitCode: num(p.exitCode),
					durationMs: num(p.durationMs),
					outputSize: num(p.outputSize),
				});
			}
			return { processes };
		},
	};
}

export interface MemoryState {
	extractionJobs: Bag[];
	extractedMemories: Bag[];
}

export function createMemoryProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	MemoryState
> {
	return {
		name: "Memory",
		reads: ["Conversation"],
		writes: [],
		initialState: (): MemoryState => ({ extractionJobs: [], extractedMemories: [] }),
		reduce: (state, event) => {
			if (event.type === "memory_extraction_started")
				return { ...state, extractionJobs: append(state.extractionJobs, payload(event), 100) };
			if (event.type === "memory_extraction_completed") {
				return { ...state, extractedMemories: append(state.extractedMemories, payload(event), 200) };
			}
			return state;
		},
	};
}

export interface ContextUsageState {
	totalTokens: number;
	softCap: number;
	hardCap: number;
	softCapExceeded: boolean;
	shouldEmitSoftCapExceeded: boolean;
}

export const ContextUsageSignals = {
	softCapExceeded: createSignal("ContextUsage/softCapExceeded", "Context usage exceeded the soft cap"),
};

export function createContextUsageProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	ContextUsageState
> {
	return {
		name: "ContextUsage",
		reads: [],
		writes: [],
		signals: [ContextUsageSignals.softCapExceeded],
		initialState: (): ContextUsageState => ({
			totalTokens: 0,
			softCap: DEFAULT_CONTEXT_LIMIT_POLICY.softCapMaxTokens,
			hardCap: 0,
			softCapExceeded: false,
			shouldEmitSoftCapExceeded: false,
		}),
		reduce: (state, event) => {
			if (event.type !== "usage_recorded" && event.type !== "message_end") {
				return state.shouldEmitSoftCapExceeded ? { ...state, shouldEmitSoftCapExceeded: false } : state;
			}
			const p = payload(event);
			const totalTokens = num(p.totalTokens, state.totalTokens);
			const softCap = num(p.softCap, state.softCap);
			const hardCap = num(p.hardCap, state.hardCap);
			const softCapExceeded = softCap > 0 && totalTokens >= softCap;
			return {
				totalTokens,
				softCap,
				hardCap,
				softCapExceeded,
				shouldEmitSoftCapExceeded: softCapExceeded && !state.softCapExceeded,
			};
		},
		extractSignals: (state): Signal[] =>
			state.shouldEmitSoftCapExceeded ? [{ type: ContextUsageSignals.softCapExceeded.type, payload: state }] : [],
	};
}

export interface InterruptState {
	pending: boolean;
	reason: string | null;
}

export function createInterruptProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	InterruptState
> {
	return {
		name: "Interrupt",
		reads: [],
		writes: [],
		initialState: (): InterruptState => ({ pending: false, reason: null }),
		reduce: (state, event) => {
			if (event.type === "interrupt_requested")
				return { pending: true, reason: str(payload(event).reason, null as never) };
			if (event.type === "interrupt_resolved") return { pending: false, reason: null };
			return state;
		},
	};
}

export interface SkillState {
	activeSkills: Array<{ skillName: string; skillPath?: string; hasArgs?: boolean }>;
}

export function createSkillProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	SkillState
> {
	return {
		name: "Skill",
		reads: ["SessionContext"],
		writes: [],
		initialState: (): SkillState => ({ activeSkills: [] }),
		reduce: (state, event) =>
			event.type === "skill_activated"
				? { activeSkills: append(state.activeSkills, payload(event) as SkillState["activeSkills"][number], 100) }
				: state,
	};
}

export interface ErrorState {
	errors: Bag[];
	lastError: Bag | null;
}

export const ErrorSignals = {
	raised: createSignal("Error/raised", "An error was raised"),
};

export function createErrorProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	ErrorState
> {
	return {
		name: "Error",
		reads: [],
		writes: [],
		signals: [ErrorSignals.raised],
		initialState: (): ErrorState => ({ errors: [], lastError: null }),
		reduce: (state, event) => {
			if (event.type === "error_raised" || event.type === "session.role_error") {
				const p = payload(event);
				return { errors: append(state.errors, p, 100), lastError: p };
			}
			if (event.type === "error_resolved") return { ...state, lastError: null };
			return state;
		},
		extractSignals: (state, event): Signal[] =>
			event.type === "error_raised" || event.type === "session.role_error"
				? [{ type: ErrorSignals.raised.type, payload: state.lastError }]
				: [],
	};
}

export interface UsageState {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
	missingReason: string | null;
}

export function createUsageProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	UsageState
> {
	return {
		name: "Usage",
		reads: [],
		writes: [],
		initialState: (): UsageState => ({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			cost: 0,
			missingReason: null,
		}),
		reduce: (state, event) => {
			if (event.type !== "usage_recorded") return state;
			const p = payload(event);
			const inputTokens = num(p.inputTokens);
			const outputTokens = num(p.outputTokens);
			const cacheReadTokens = num(p.cacheReadTokens);
			const cacheWriteTokens = num(p.cacheWriteTokens);
			const totalTokens = num(p.totalTokens, inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens);
			return {
				inputTokens: state.inputTokens + inputTokens,
				outputTokens: state.outputTokens + outputTokens,
				cacheReadTokens: state.cacheReadTokens + cacheReadTokens,
				cacheWriteTokens: state.cacheWriteTokens + cacheWriteTokens,
				totalTokens: state.totalTokens + totalTokens,
				cost: state.cost + num(p.cost),
				missingReason: typeof p.missingReason === "string" ? p.missingReason : null,
			};
		},
	};
}

export interface StreamState {
	chunks: Array<{ type: string; text: string; timestamp: string }>;
	isStreaming: boolean;
}

export function createStreamProjection<TEvent extends EventEnvelope = EventEnvelope>(): ProjectionDefinition<
	TEvent,
	StreamState
> {
	return {
		name: "Stream",
		reads: [],
		writes: [],
		initialState: (): StreamState => ({ chunks: [], isStreaming: false }),
		reduce: (state, event) => {
			if (event.type === "thinking_start" || event.type === "message_start") return { ...state, isStreaming: true };
			if (event.type === "thinking_end" || event.type === "message_end") return { ...state, isStreaming: false };
			if (event.type === "thinking_chunk" || event.type === "message_chunk") {
				return {
					...state,
					chunks: append(
						state.chunks,
						{
							type: event.type,
							text: str(payload(event).text, str(payload(event).delta)),
							timestamp: event.timestamp,
						},
						1000,
					),
				};
			}
			return state;
		},
	};
}

export function createBuiltinExtendedProjections<TEvent extends EventEnvelope = EventEnvelope>(): Array<
	ProjectionDefinition<TEvent, unknown>
> {
	return [
		createSessionContextProjection<TEvent>(),
		createConversationProjection<TEvent>(),
		createAgentRoutingProjection<TEvent>(),
		createDisplayProjection<TEvent>(),
		createAutopilotStateProjection<TEvent>(),
		createPermissionPolicyProjection<TEvent>(),
		createTurnProjection<TEvent>(),
		createForkProjection<TEvent>(),
		createAgentStatusProjection<TEvent>(),
		createShellProcessProjection<TEvent>(),
		createMemoryProjection<TEvent>(),
		createContextUsageProjection<TEvent>(),
		createInterruptProjection<TEvent>(),
		createSkillProjection<TEvent>(),
		createErrorProjection<TEvent>(),
		createUsageProjection<TEvent>(),
		createStreamProjection<TEvent>(),
	] as Array<ProjectionDefinition<TEvent, unknown>>;
}
