/**
 * ATIF (Agent Trajectory Interchange Format) v1.7 export/import.
 *
 * Pure conversion module — no side effects. Converts between Pi session entries
 * and the ATIF v1.7 shape inspired by the Harbor Agent Trajectory Format.
 *
 * Legacy format (version 1) is still supported for backward compatibility.
 * The v1.7 format adds richer metadata, structured steps, and vendor extensions.
 */

import { JSONSchema } from "effect";
import type { SessionEntry, SessionHeader } from "./session-manager.ts";

/**
 * Normalize a piki StopReason to the mag alpha22 ATIF outcome tag vocabulary.
 * mag's `mapFinishReasonToOutcome` emits `Completed`/`OutputTruncated`/
 * `ContentFiltered`; piki's raw stopReason is lowercased. error/aborted are not
 * part of mag's outcome taxonomy and are passed through unchanged.
 */
function normalizeAtifOutcome(stopReason: string): string {
	switch (stopReason) {
		case "stop":
		case "toolUse":
			return "Completed";
		case "length":
			return "OutputTruncated";
		case "contentFiltered":
			return "ContentFiltered";
		default:
			return stopReason;
	}
}

// ============================================================================
// ATIF v1.7 Schema Types
// ============================================================================

/** alpha22-compatible tool definition: a flat function-call shape. */
export interface AtifToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: unknown;
	};
}

/** Token/cost totals for a completed trajectory (alpha22 `final_metrics`). */
export interface AtifFinalMetrics {
	total_prompt_tokens: number;
	total_completion_tokens: number;
	total_cached_tokens: number;
	total_cost_usd: number;
	total_steps: number;
}

/** ATIF v1.7 trajectory metadata */
export interface AtifMetadata {
	/** Format identifier */
	format: "atif";
	/** Schema version */
	version: 1 | 1.7;
	/** ISO 8601 creation timestamp */
	createdAt: string;
	/** Agent/executor identifier */
	agent: string;
	/** Agent version */
	agentVersion?: string;
	/** Working directory */
	cwd?: string;
	/** Model used for the session */
	model?: string;
	/** Provider used for the session */
	provider?: string;
	/** Session ID from Pi */
	sessionId?: string;
	/** User-defined session name */
	sessionName?: string;
	/** Parent session path if forked */
	parentSessionPath?: string;
	/** Total message count */
	messageCount?: number;
	/** Pi-specific vendor extensions */
	vendor?: Record<string, unknown>;
}

/** ATIF v1.7 message content block */
export interface AtifContentBlock {
	type: string;
	text?: string;
	/** Tool use specific fields */
	name?: string;
	id?: string;
	input?: unknown;
	/** Tool result specific fields */
	tool_use_id?: string;
	content?: string | AtifContentBlock[];
	/** Image specific fields */
	source?: {
		type: "base64";
		media_type: string;
		data: string;
	};
}

/** ATIF v1.7 step (converts from Pi session entries) */
export interface AtifStep {
	/** Step ID (from session entry ID) */
	id: string;
	/** Parent step ID */
	parentId: string | null;
	/** ISO 8601 timestamp */
	timestamp: string;
	/** Step type: message, compaction, branch_summary, custom, etc. */
	type: string;
	/** Role (for message steps) */
	role?: string;
	/** Content blocks (for message steps) */
	content?: AtifContentBlock[];
	/** Step metadata */
	metadata?: Record<string, unknown>;
}

/**
 * ATIF v1.7 trajectory (Pi envelope format)
 */
export interface AtifTrajectoryV17 {
	format: "atif";
	version: 1.7;
	/** Trajectory-level metadata */
	metadata: AtifMetadata;
	/** Session header as vendor extension */
	vendor: {
		piki?: {
			sessionHeader: SessionHeader | null;
			entries: SessionEntry[];
		};
	};
	/** Steps array (structured representation) */
	steps: AtifStep[];
}

/**
 * ATIF v1.7 trajectory (flat schema)
 */
export interface AtifTrajectoryV17Flat {
	/** Schema version identifier */
	schema_version: "ATIF-v1.7";
	/** Optional session ID */
	session_id?: string;
	/** Trajectory identifier */
	trajectory_id: string;
	/** Agent metadata */
	agent: {
		name: string;
		version?: string;
		model_name?: string;
		tool_definitions?: AtifToolDefinition[];
	};
	/** Steps array */
	steps: AtifStep[];
	/** Optional notes */
	notes?: string;
	/** Optional final metrics */
	final_metrics?: AtifFinalMetrics;
}

/** Legacy ATIF v1 trajectory (backward compatible) */
export interface AtifTrajectoryLegacy {
	format: "atif";
	version: 1;
	session: SessionHeader | null;
	entries: SessionEntry[];
}

/** Union type for all ATIF versions */
export type AtifTrajectory = AtifTrajectoryV17 | AtifTrajectoryLegacy | AtifTrajectoryV17Flat | AtifDocument;

// ============================================================================
// Pure Conversion Functions
// ============================================================================

/**
 * Convert Pi session entries to ATIF v1.7 steps.
 */
export function entriesToSteps(entries: SessionEntry[]): AtifStep[] {
	return entries.map((entry) => {
		const base: AtifStep = {
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			type: entry.type,
		};

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				base.role = msg.role;
				if ("content" in msg && msg.content) {
					base.content = convertMessageContent(msg.content);
				}
				break;
			}
			case "compaction":
				base.metadata = {
					summary: entry.summary,
					firstKeptEntryId: entry.firstKeptEntryId,
					tokensBefore: entry.tokensBefore,
					fromHook: entry.fromHook,
				};
				break;
			case "branch_summary":
				base.metadata = {
					fromId: entry.fromId,
					summary: entry.summary,
					fromHook: entry.fromHook,
				};
				break;
			case "model_change":
				base.metadata = {
					provider: entry.provider,
					modelId: entry.modelId,
				};
				break;
			case "thinking_level_change":
				base.metadata = {
					thinkingLevel: entry.thinkingLevel,
				};
				break;
			case "session_info":
				base.metadata = {
					name: entry.name,
				};
				break;
			case "label":
				base.metadata = {
					targetId: entry.targetId,
					label: entry.label,
				};
				break;
			case "custom":
				base.metadata = {
					customType: entry.customType,
					data: entry.data,
				};
				break;
			case "custom_message":
				base.role = "custom";
				base.metadata = {
					customType: entry.customType,
					display: entry.display,
					details: entry.details,
				};
				base.content = convertMessageContent(entry.content);
				break;
			default:
				// Unknown entry type — store as metadata
				base.metadata = { raw: entry };
				break;
		}

		return base;
	});
}

/**
 * Convert message content to ATIF content blocks.
 */
function convertMessageContent(
	content: string | Array<{ type: string; [key: string]: unknown }> | Array<{ type: string }>,
): AtifContentBlock[] | undefined {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (Array.isArray(content)) {
		return content.map((block) => {
			const result: AtifContentBlock = { type: block.type };
			if ("text" in block && typeof block.text === "string") {
				result.text = block.text;
			}
			if ("name" in block) result.name = block.name as string;
			if ("id" in block) result.id = block.id as string;
			if ("input" in block) result.input = block.input;
			if ("tool_use_id" in block) result.tool_use_id = block.tool_use_id as string;
			if ("content" in block) {
				if (typeof block.content === "string") {
					result.content = block.content;
				}
			}
			if ("source" in block && typeof block.source === "object" && block.source !== null) {
				result.source = block.source as AtifContentBlock["source"];
			}
			return result;
		});
	}
	return undefined;
}

/**
 * Build ATIF v1.7 metadata from session header and entries.
 */
export function buildAtifMetadata(sessionHeader: SessionHeader | null, entries: SessionEntry[]): AtifMetadata {
	let model: string | undefined;
	let provider: string | undefined;
	let messageCount = 0;
	let sessionName: string | undefined;

	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "assistant" && "model" in msg) {
				model = (msg as { model?: string }).model;
				provider = (msg as { provider?: string }).provider;
			}
			if (msg.role === "user" || msg.role === "assistant") {
				messageCount++;
			}
		}
		if (entry.type === "model_change") {
			model = entry.modelId;
			provider = entry.provider;
		}
		if (entry.type === "session_info") {
			sessionName = entry.name;
		}
	}

	return {
		format: "atif",
		version: 1.7,
		createdAt: sessionHeader?.timestamp ?? new Date().toISOString(),
		agent: "piki",
		agentVersion: undefined, // Populated by caller if available
		cwd: sessionHeader?.cwd,
		model,
		provider,
		sessionId: sessionHeader?.id,
		sessionName,
		parentSessionPath: sessionHeader?.parentSession,
		messageCount,
	};
}

/**
 * Convert a tool definition (as surfaced by `AgentSession.getAllTools()`) into
 * the alpha22-compatible flat function-call `tool_definitions` entry. TypeBox
 * parameter schemas are serialized to JSON Schema, mirroring how the runtime
 * encodes tools for the chat-completions API.
 */
export function toAtifToolDefinitions(
	tools: ReadonlyArray<{ name: string; description: string; parameters?: unknown }>,
): AtifToolDefinition[] {
	const stripMeta = (node: unknown): unknown => {
		if (node === null || node === undefined) return node;
		if (Array.isArray(node)) return node.map(stripMeta);
		if (typeof node !== "object") return node;
		const obj = node as Record<string, unknown>;
		const keys = Object.keys(obj);
		if (keys.every((k) => k === "$id" || k === "title" || k === "$schema")) return {};
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			if (k === "$id" || k === "$schema") continue;
			result[k] = typeof v === "object" ? stripMeta(v) : v;
		}
		return result;
	};

	// Tools register plain JSON-schema parameter objects (TypeBox). Passing
	// those directly to `JSONSchema.make` throws because they are not effect
	// `Schema` ASTs. Only run `JSONSchema.make` when the input is a real effect
	// Schema (detected via an `ast` property); otherwise serialize the plain
	// object directly through `stripMeta`.
	const isEffectSchema = (value: unknown): value is { ast: unknown } =>
		typeof value === "object" && value !== null && "ast" in value;

	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters:
				tool.parameters !== undefined
					? stripMeta(
							isEffectSchema(tool.parameters) ? JSONSchema.make(tool.parameters as never) : tool.parameters,
						)
					: {},
		},
	}));
}

/**
 * Compute real token/cost totals across all assistant messages in the session.
 */
export function computeAtifFinalMetrics(entries: SessionEntry[]): AtifFinalMetrics {
	let prompt = 0;
	let completion = 0;
	let cached = 0;
	let cost = 0;
	let steps = 0;

	for (const entry of entries) {
		// alpha22 counts every step (user, assistant, toolResult, AND non-message
		// system steps such as compaction / branch_summary / observer / interrupt /
		// agent_created). `fork.steps.length` is the total step count, not just
		// message entries. We mirror that by counting each entry as one step.
		steps += 1;
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "assistant" && "usage" in msg && msg.usage) {
			const usage = msg.usage as {
				input?: number;
				output?: number;
				cacheRead?: number;
				cost?: { total?: number };
			};
			prompt += usage.input ?? 0;
			completion += usage.output ?? 0;
			cached += usage.cacheRead ?? 0;
			cost += usage.cost?.total ?? 0;
		}
	}

	return {
		total_prompt_tokens: prompt,
		total_completion_tokens: completion,
		total_cached_tokens: cached,
		total_cost_usd: Number(cost.toFixed(6)),
		total_steps: steps,
	};
}

/**
 * Export session as ATIF v1.7 flat-schema trajectory.
 * Uses a flat schema shape for interoperability with consumers expecting the flat layout.
 */
export function exportAtifV17Flat(
	sessionHeader: SessionHeader | null,
	entries: SessionEntry[],
	options?: { toolDefinitions?: AtifToolDefinition[] },
): AtifTrajectoryV17Flat {
	// Extract model name and agent info from entries
	let model: string | undefined;
	let messageCount = 0;

	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "assistant" && "model" in msg) {
				model = (msg as { model?: string }).model;
			}
			if (msg.role === "user" || msg.role === "assistant") {
				messageCount++;
			}
		}
		if (entry.type === "model_change") {
			model = entry.modelId;
		}
	}

	return {
		schema_version: "ATIF-v1.7",
		...(sessionHeader?.id ? { session_id: sessionHeader.id } : {}),
		trajectory_id: "main",
		agent: {
			name: "piki",
			version: undefined,
			model_name: model,
			...(options?.toolDefinitions ? { tool_definitions: options.toolDefinitions } : {}),
		},
		steps: entriesToSteps(entries),
		...(messageCount > 0
			? {
					final_metrics: computeAtifFinalMetrics(entries),
				}
			: {}),
	};
}

/**
 * Export session as an alpha22 (Magnitude) compatible ATIF-v1.7 document.
 *
 * Emits the exact alpha22 envelope: `schema_version`, `trajectory_id`,
 * `agent.{name,version,tool_definitions}`, an ordered `steps` array in the
 * alpha22 step vocabulary (user/agent steps with `tool_calls` + `observation`
 * merged into a single agent step), real `final_metrics`, and an empty
 * `subagent_trajectories` array.
 */
export interface AtifAlpha22Options {
	/** Active tool definitions (from `AgentSession.getAllTools()`). */
	toolDefinitions?: AtifToolDefinition[];
	/** Override the agent name (alpha22 uses "magnitude"). */
	agentName?: string;
	/** Override the agent version (alpha22 uses "1.0.0"). */
	agentVersion?: string;
	/** Per-fork captured worker entries, keyed by forkId. Populates `subagent_trajectories`. */
	forkEntries?: Map<string, SessionEntry[]>;
	/**
	 * Per-fork real fork metadata, keyed by forkId. Captured from the
	 * `agent_created` runtime event by `WorkerExecutor` and surfaced via
	 * `AgentSession.getForkMeta()`. Drives the `source:"agent"` spawn step's
	 * real `agentId`/`role`/`taskId`/`mode`/`message` instead of the older
	 * `spawnWorker-<forkId>` placeholder. Optional; falls back to forkId when
	 * a fork has no recorded metadata.
	 */
	forkMeta?: Map<
		string,
		{
			agentId: string;
			parentForkId: string | null;
			role: string;
			taskId: string | undefined;
			mode: string;
			message: string | undefined;
		}
	>;
}

export function exportAtifAlpha22(
	_sessionHeader: SessionHeader | null,
	entries: SessionEntry[],
	options: AtifAlpha22Options = {},
): AtifDocument {
	const steps = entriesToAlpha22Steps(entries);
	const metrics = computeAtifFinalMetrics(entries);
	const toolDefs = options.toolDefinitions ?? [];

	// Derive the active model name from the session entries (mirrors the flat
	// builder / per-step `assistant.model`). Take the last assistant message
	// that carried a model, falling back to the last model_change entry.
	let model: string | undefined;
	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "assistant" && "model" in msg && (msg as { model?: string }).model) {
				model = (msg as { model?: string }).model;
			}
		} else if (entry.type === "model_change") {
			model = entry.modelId;
		}
	}

	const subagent_trajectories: unknown[] = [];
	if (options.forkEntries) {
		for (const [forkId, forkEntries] of options.forkEntries) {
			if (!forkEntries.length) continue;
			const forkSteps = entriesToAlpha22Steps(forkEntries);
			const forkMetrics = computeAtifFinalMetrics(forkEntries);
			metrics.total_steps += forkMetrics.total_steps;
			metrics.total_prompt_tokens += forkMetrics.total_prompt_tokens;
			metrics.total_completion_tokens += forkMetrics.total_completion_tokens;
			metrics.total_cached_tokens += forkMetrics.total_cached_tokens;
			metrics.total_cost_usd = Number((metrics.total_cost_usd + forkMetrics.total_cost_usd).toFixed(6));
			subagent_trajectories.push({
				schema_version: "ATIF-v1.7",
				trajectory_id: forkId,
				agent: {
					// alpha22 names subagent trajectories by their worker role
					// (e.g. "scientist", "engineer"), not a constant. Fall back to
					// the fork metadata role, then agentName, then "piki".
					name: options.forkMeta?.get(forkId)?.role ?? options.agentName ?? "piki",
					version: options.agentVersion ?? "1.0.0",
					tool_definitions: toolDefs,
				},
				steps: forkSteps,
				...(forkSteps.length > 0 ? { final_metrics: forkMetrics } : {}),
			});
		}
	}

	// S6/C3: alpha22 emits an `agent_created` step on the *parent* (root) fork
	// for every spawned worker, shaped as a `source:"agent"` step with a
	// `spawnWorker` tool_call and an `observation.results` entry carrying a
	// `subagent_trajectory_ref` linking to the child trajectory. piki has no
	// dedicated `agent_created` runtime event, but each fork in `forkEntries`
	// is exactly a spawned worker; emit one such step per fork into the root
	// `steps` so the parent→child link is represented.
	//
	// C3 ordering fix: mag calls `emitStep(parentFork, agentCreatedToStep(...))`
	// on the PARENT fork at the moment of worker creation, so the spawn step is
	// INTERLEAVED into the parent's step sequence right after the leader step
	// that issued the spawn (its `step_id = parentFork.steps.length + 1` at that
	// instant) — NOT appended at the very end. To mirror that, we locate the
	// leader step whose `spawn_worker` tool_call matches this fork (by
	// `agentId`/`taskId`) and splice the synthetic spawn step immediately after
	// it. If no matching leader tool_call is found, we append at the tail
	// (fallback), preserving prior behavior. Observer/interrupt steps are
	// intentionally NOT fabricated: piki has no `observer`/`interrupt`
	// session-entry types, so per the parity plan they are no-ops until piki
	// captures such events.
	if (options.forkEntries) {
		// Pre-index leader steps that carry a `spawn_worker` tool_call, so each
		// fork can be matched by its `agentId`/`taskId` to the step that spawned
		// it. Keyed by `agentId` then `taskId`.
		const spawnCallSteps = new Map<string, number>();
		for (let i = 0; i < steps.length; i++) {
			const s = steps[i]!;
			if (s.source !== "agent" || !("tool_calls" in s) || !s.tool_calls) continue;
			for (const tc of s.tool_calls) {
				if (tc.function_name !== "spawn_worker") continue;
				const args = tc.arguments as { agentId?: string; taskId?: string } | undefined;
				const key = `${args?.agentId ?? ""}|${args?.taskId ?? ""}`;
				// First leader step that spawns this worker wins.
				if (!spawnCallSteps.has(key)) spawnCallSteps.set(key, i);
			}
		}

		for (const [forkId] of options.forkEntries) {
			const meta = options.forkMeta?.get(forkId);
			const agentId = meta?.agentId ?? forkId;
			const taskId = meta?.taskId ?? forkId;
			const argumentsObj: Record<string, unknown> = {
				role: meta?.role ?? "worker",
				taskId,
				mode: meta?.mode ?? "spawn",
			};
			if (meta?.message) {
				argumentsObj.message = meta.message;
			}
			const spawnStep: AtifAlpha22Step = {
				step_id: 0, // assigned below after we know the final length
				timestamp: new Date().toISOString(),
				source: "agent",
				model_name: "unknown",
				message: "",
				tool_calls: [
					{
						tool_call_id: agentId,
						function_name: "spawnWorker",
						arguments: argumentsObj,
						extra: { cached: false },
					},
				],
				observation: {
					results: [
						{
							source_call_id: agentId,
							content: "",
							subagent_trajectory_ref: [{ trajectory_id: agentId }],
						},
					],
				},
				llm_call_count: 0,
				extra: {
					agentId,
					forkId,
					parentForkId: meta?.parentForkId ?? null,
					taskId,
				},
			};

			// C3: insert right after the leader step that issued this spawn,
			// matching by agentId/taskId. Fall back to appending at the tail.
			const matchKey = `${agentId}|${taskId}`;
			const leaderIdx = spawnCallSteps.get(matchKey);
			if (leaderIdx !== undefined) {
				steps.splice(leaderIdx + 1, 0, spawnStep);
				// Shift any later spawn_call indices that were after the insert point.
				for (const [k, idx] of spawnCallSteps) {
					if (idx > leaderIdx) spawnCallSteps.set(k, idx + 1);
				}
			} else {
				steps.push(spawnStep);
			}
		}
		// Re-number step_id across the merged root steps so the synthetic
		// spawnWorker steps stay monotonic with the leader steps.
		steps.forEach((s, idx) => {
			s.step_id = idx + 1;
		});
	}

	return {
		schema_version: "ATIF-v1.7",
		trajectory_id: "main",
		...(_sessionHeader?.id ? { session_id: _sessionHeader.id } : {}),
		agent: {
			name: options.agentName ?? "piki",
			version: options.agentVersion ?? "1.0.0",
			model_name: model,
			tool_definitions: toolDefs,
		},
		steps,
		final_metrics: metrics,
		subagent_trajectories,
	};
}

/** alpha22-compatible ATIF document shape. */
export interface AtifDocument {
	schema_version: "ATIF-v1.7";
	trajectory_id: string;
	/** Session ID from Pi (alpha22 `session_id`). */
	session_id?: string;
	agent: {
		name: string;
		version: string;
		/** Active model name (alpha22 `agent.model_name`). */
		model_name?: string;
		tool_definitions: AtifToolDefinition[];
	};
	steps: AtifAlpha22Step[];
	final_metrics: AtifFinalMetrics;
	subagent_trajectories: unknown[];
}

export type AtifAlpha22Step =
	| {
			step_id: number;
			timestamp: string;
			source: "user";
			message: string;
			extra: { messageId: string; forkId: string | null };
	  }
	| {
			/** alpha22 `interruptToStep`: a user-scoped step recording an interruption. */
			step_id: number;
			timestamp: string;
			source: "user";
			message: string;
			llm_call_count: 0;
			extra: { forkId: string | null; allKilled: boolean };
	  }
	| {
			step_id: number;
			timestamp: string;
			source: "agent";
			model_name: string;
			message: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				tool_call_id: string;
				function_name: string;
				arguments: unknown;
				extra?: { cached?: boolean };
			}>;
			observation?: {
				results: Array<{
					source_call_id: string;
					content: string;
					/** alpha22 `subagent_trajectory_ref` links an observation to a child trajectory. */
					subagent_trajectory_ref?: Array<{ trajectory_id: string }>;
					/** alpha22 encodes per-result disposition (error/denied/interrupted/inputRejected). piki surfaces only `isError`. */
					extra?: { error?: boolean };
				}>;
			};
			metrics?: {
				prompt_tokens: number;
				completion_tokens: number;
				cached_tokens: number;
				extra?: { provider_id: string; model_id: string; cache_creation_input_tokens?: number };
				cost_usd: number;
			};
			llm_call_count: number;
			extra: Record<string, unknown>;
	  }
	| {
			/** System/event steps (compaction, branch summary, observer outcome). */
			step_id: number;
			timestamp: string;
			source: "system";
			message: string;
			/**
			 * alpha22 emits an object here:
			 * `{ type: "compaction", boundary: "replace", compactedMessageCount, ... }`.
			 * It is present (non-undefined) only on compaction steps.
			 */
			context_management?: {
				type: "compaction";
				boundary: "replace";
				compactedMessageCount?: number;
				[key: string]: unknown;
			};
			observer?: boolean;
			llm_call_count: number;
			extra: Record<string, unknown>;
	  };

/**
 * Map piki session entries to alpha22 step objects, merging each assistant
 * turn's tool calls with their following tool-result entries into a single
 * agent step (matching alpha22's merged `tool_calls` + `observation` model).
 *
 * The numeric `step_id` counter is independent of the loop index used to walk
 * `entries` and consume following tool-result entries, so consuming N
 * tool-results does not advance the emitted step sequence. Reasoning
 * (thinking) content is surfaced via a dedicated `reasoning_content` field,
 * while `message` carries only the assistant's literal text. The model name is
 * emitted raw (no `role/` prefix) as alpha22 expects.
 */
function entriesToAlpha22Steps(entries: SessionEntry[]): AtifAlpha22Step[] {
	const steps: AtifAlpha22Step[] = [];
	let stepId = 0;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		// S6: non-message event steps (compaction, branch summary, custom,
		// custom_message, model/thinking change, session info, label) become
		// alpha22-compatible `source:"system"` steps with their details carried
		// in `extra`. Observer outcomes have no dedicated piki entry type yet, so
		// they are intentionally skipped (documented gap).
		if (entry.type !== "message") {
			const source = "system" as const;
			let message = "";
			const extra: Record<string, unknown> = { entryType: entry.type };
			let contextManagement:
				| { type: "compaction"; boundary: "replace"; compactedMessageCount?: number; [key: string]: unknown }
				| undefined;
			let observation: { results: Array<{ source_call_id: string; content: string }> } | undefined;
			switch (entry.type) {
				case "compaction": {
					message = entry.summary ?? "Context compaction performed";
					// alpha22 `compactionPreparedToStep` emits an object
					// `{ type:"compaction", boundary:"replace", compactedMessageCount, ... }`
					// where `compactedMessageCount` is the number of message entries removed
					// by THIS compaction. mag applies each compaction to a live
					// `windowState.messages`, keeping from `firstKeptEntryId` (inclusive) and
					// dropping the prefix (`fork.messages.slice(1 + compactedMessageCount)`,
					// magnitude-alpha22.embedded.js:114352 / computeCompactionSizing:136861),
					// and prior compactions shrink that live window first. We replay prior
					// compactions to reconstruct the live window, then count the message
					// entries in THIS window that precede `entry.firstKeptEntryId`
					// (exclusive) — i.e. the messages THIS compaction actually removes.
					// This bounds the count to the current window so a prior compaction's
					// removed messages are not re-counted (the prior naive linear scan
					// over-counted nested compactions). When `firstKeptEntryId` is absent
					// from the stream, we fall back to counting the messages that precede
					// the compaction entry (the live-window prefix).
					let prevKept: string | undefined;
					for (const e of entries) {
						if (e === entry) break;
						if (e.type === "compaction") prevKept = e.firstKeptEntryId;
					}
					let compactedMessageCount = 0;
					let inWindow = prevKept === undefined;
					for (const e of entries) {
						if (e === entry) break;
						if (e.type === "compaction") continue;
						if (!inWindow) {
							if (e.id === prevKept) inWindow = true;
							else continue;
						}
						if (e.id === entry.firstKeptEntryId) break;
						if (e.type === "message") compactedMessageCount += 1;
					}
					contextManagement = {
						type: "compaction",
						boundary: "replace",
						compactedMessageCount,
						firstKeptEntryId: entry.firstKeptEntryId,
						tokensBefore: entry.tokensBefore,
						fromHook: entry.fromHook,
					};
					if ((entry.details as { fallback?: boolean } | undefined)?.fallback === true) {
						contextManagement.isFallback = true;
					}
					extra.firstKeptEntryId = entry.firstKeptEntryId;
					extra.tokensBefore = entry.tokensBefore;
					extra.fromHook = entry.fromHook;
					// alpha22 `compactionPreparedToStep` emits an `observation.results`
					// carrying the compaction summary (when not a fallback). Mirror that so
					// mag-trained consumers can read the compaction content.
					observation = entry.summary
						? { results: [{ source_call_id: `compaction-${entry.id}`, content: entry.summary }] }
						: undefined;
					break;
				}
				case "branch_summary":
					message = entry.summary ?? "Branch summary";
					extra.fromId = entry.fromId;
					extra.fromHook = entry.fromHook;
					break;
				case "custom":
					message = String(entry.data ?? "");
					extra.customType = entry.customType;
					break;
				case "custom_message":
					message = typeof entry.content === "string" ? entry.content : extractText(entry.content);
					extra.customType = entry.customType;
					extra.display = entry.display;
					break;
				case "model_change":
					message = `Model changed to ${entry.modelId}`;
					extra.provider = entry.provider;
					extra.modelId = entry.modelId;
					break;
				case "thinking_level_change":
					message = `Thinking level changed to ${entry.thinkingLevel}`;
					extra.thinkingLevel = entry.thinkingLevel;
					break;
				case "session_info":
					message = `Session name: ${entry.name}`;
					extra.name = entry.name;
					break;
				case "label":
					message = `Label ${entry.label} on ${entry.targetId}`;
					extra.targetId = entry.targetId;
					extra.label = entry.label;
					break;
				case "observer":
					// S8: observer assessment step. piki never emits mag-only fields
					// (reasoning/observedTurnId/observerTurnId/chainId), so we only
					// surface the signals piki actually carries.
					message = entry.escalate
						? `<escalation_required>\n${entry.justification ?? ""}\n</escalation_required>`
						: "Observer assessment: pass";
					extra.observer = true;
					extra.escalate = entry.escalate;
					if (entry.justification !== undefined) extra.justification = entry.justification;
					break;
				case "interrupt": {
					// S8: alpha22 `interruptToStep` emits a `source:"user"` step with
					// `extra:{forkId, allKilled}` and message "All agents interrupted"
					// (allKilled) or "Agent interrupted". piki records the same signals
					// via InterruptEntry (appendInterrupt).
					message = entry.message;
					const step: AtifAlpha22Step = {
						step_id: ++stepId,
						timestamp: entry.timestamp,
						source: "user",
						message,
						llm_call_count: 0,
						extra: { forkId: entry.forkId ?? null, allKilled: entry.allKilled },
					};
					steps.push(step);
					continue;
				}
				default:
					continue;
			}
			steps.push({
				step_id: ++stepId,
				timestamp: entry.timestamp,
				source,
				message,
				...(observation === undefined ? {} : { observation }),
				llm_call_count: 0,
				extra: {
					...extra,
					// alpha22 nests `context_management` under `extra`
					// (compactionPreparedToStep), NOT as a top-level key.
					...(contextManagement === undefined ? {} : { context_management: contextManagement }),
				},
			});
			continue;
		}
		const msg = entry.message;

		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
			steps.push({
				step_id: ++stepId,
				timestamp: entry.timestamp,
				source: "user",
				message: text,
				extra: { messageId: entry.id, forkId: entry.forkId ?? null },
			});
			continue;
		}

		if (msg.role === "assistant") {
			const assistant = msg as {
				content?: Array<{
					type: string;
					text?: string;
					thinking?: string;
					id?: string;
					name?: string;
					arguments?: unknown;
				}>;
				usage?: {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					cost?: { total?: number };
				};
				model?: string;
				provider?: string;
				timestamp?: number;
				stopReason?: string;
				responseId?: string;
			};
			const blocks = assistant.content ?? [];
			// `message` carries only literal text blocks; thinking is surfaced
			// separately via reasoning_content.
			const text = blocks
				.filter((b) => b.type === "text" && typeof b.text === "string")
				.map((b) => b.text as string)
				.join("\n");
			const reasoning = blocks
				.filter((b) => b.type === "thinking" && typeof b.thinking === "string" && b.thinking.length > 0)
				.map((b) => b.thinking as string)
				.join("\n");
			const toolCalls = blocks
				.filter((b) => b.type === "toolCall")
				.map((tc) => ({
					tool_call_id: tc.id ?? "",
					function_name: tc.name ?? "",
					arguments: tc.arguments ?? {},
					extra: { cached: false },
				}));

			// Consume following toolResult entries as this turn's observation.
			// Uses the loop index `i`, NOT the stepId counter.
			const observationResults: Array<{
				source_call_id: string;
				content: string;
				extra?: { error: boolean };
			}> = [];
			while (i + 1 < entries.length) {
				const next = entries[i + 1]!;
				if (next.type !== "message" || next.message.role !== "toolResult") break;
				i++;
				const tr = next.message as {
					toolCallId?: string;
					content?: string | Array<{ type: string; text?: string }>;
					isError?: boolean;
				};
				observationResults.push({
					source_call_id: tr.toolCallId ?? "",
					content: typeof tr.content === "string" ? tr.content : extractText(tr.content ?? []),
					...(tr.isError ? { extra: { error: true } } : {}),
				});
			}

			const usage = assistant.usage;
			const metrics = usage
				? {
						prompt_tokens: usage.input ?? 0,
						completion_tokens: usage.output ?? 0,
						cached_tokens: usage.cacheRead ?? 0,
						extra: {
							provider_id: assistant.provider ?? "",
							model_id: assistant.model ?? "",
							cache_creation_input_tokens: usage.cacheWrite ?? 0,
						},
						cost_usd: Number((usage.cost?.total ?? 0).toFixed(6)),
					}
				: undefined;

			const isNoLlm =
				entry.llmFailed === true && text.length === 0 && toolCalls.length === 0 && observationResults.length === 0;

			const step: AtifAlpha22Step = {
				step_id: ++stepId,
				timestamp: entry.timestamp,
				source: "agent",
				model_name: assistant.model ?? "unknown",
				message: text.trim() || "",
				...(reasoning ? { reasoning_content: reasoning.trim() } : {}),
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				...(observationResults.length > 0 ? { observation: { results: observationResults } } : {}),
				...(metrics ? { metrics } : {}),
				llm_call_count: isNoLlm ? 0 : 1,
				extra: {
					turnId: entry.id,
					forkId: entry.forkId ?? null,
					providerId: assistant.provider ?? "",
					modelId: assistant.model ?? "",
					...(assistant.stopReason !== undefined && assistant.stopReason !== null
						? { outcome: normalizeAtifOutcome(assistant.stopReason) }
						: {}),
					...(assistant.responseId !== undefined && assistant.responseId !== null
						? { responseId: assistant.responseId }
						: {}),
				},
			};
			steps.push(step);
		}
	}

	return steps;
}

/** Flatten message content blocks into a single text string. */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			if (typeof b === "string") return b;
			if (b && typeof b === "object" && "text" in b) return (b as { text?: string }).text ?? "";
			if (b && typeof b === "object" && "thinking" in b) return (b as { thinking?: string }).thinking ?? "";
			return "";
		})
		.filter((t) => t.length > 0)
		.join("\n");
}

/**
 * Export session as ATIF v1.7 trajectory.
 */
export function exportAtifV17(sessionHeader: SessionHeader | null, entries: SessionEntry[]): AtifTrajectoryV17 {
	return {
		format: "atif",
		version: 1.7,
		metadata: buildAtifMetadata(sessionHeader, entries),
		vendor: {
			piki: {
				sessionHeader,
				entries,
			},
		},
		steps: entriesToSteps(entries),
	};
}

/**
 * Export session as legacy ATIF (version 1) — backward compatible.
 */
export function exportAtifLegacy(sessionHeader: SessionHeader | null, entries: SessionEntry[]): AtifTrajectoryLegacy {
	return {
		format: "atif",
		version: 1,
		session: sessionHeader,
		entries,
	};
}

/**
 * Detect the ATIF version from parsed JSON.
 */
export function detectAtifVersion(data: unknown): 1 | 1.7 | null {
	if (typeof data !== "object" || data === null) return null;
	const obj = data as Record<string, unknown>;
	if (obj.format !== "atif") return null;
	if (obj.version === 1.7) return 1.7;
	if (obj.version === 1) return 1;
	return null;
}

/**
 * Extract Pi session entries from an ATIF trajectory (any version).
 * Returns entries suitable for creating a new Pi session via forkFrom.
 */
export function extractEntriesFromAtif(data: unknown): SessionEntry[] | null {
	if (typeof data !== "object" || data === null) return null;
	const obj = data as Record<string, unknown>;

	// Legacy v1: entries at top level
	if (Array.isArray(obj.entries)) {
		return obj.entries as SessionEntry[];
	}

	// v1.7: entries in vendor.piki.entries
	const vendor = obj.vendor as Record<string, unknown> | undefined;
	if (vendor) {
		const pi = vendor.piki as Record<string, unknown> | undefined;
		if (pi && Array.isArray(pi.entries)) {
			return pi.entries as SessionEntry[];
		}
	}

	return null;
}

/**
 * Extract session header from an ATIF trajectory (any version).
 */
export function extractHeaderFromAtif(data: unknown): SessionHeader | null {
	if (typeof data !== "object" || data === null) return null;
	const obj = data as Record<string, unknown>;

	// Legacy v1: session at top level
	if (obj.session && typeof obj.session === "object") {
		return obj.session as SessionHeader;
	}

	// v1.7: session header in vendor.piki.sessionHeader
	const vendor = obj.vendor as Record<string, unknown> | undefined;
	if (vendor) {
		const pi = vendor.piki as Record<string, unknown> | undefined;
		if (pi?.sessionHeader && typeof pi.sessionHeader === "object") {
			return pi.sessionHeader as SessionHeader;
		}
	}

	return null;
}
