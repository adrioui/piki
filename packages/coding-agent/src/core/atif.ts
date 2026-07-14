/**
 * ATIF (Agent Trajectory Interchange Format) v1.7 export/import.
 *
 * Pure conversion module — no side effects. Converts between Pi session entries
 * and the ATIF v1.7 shape inspired by the Harbor Agent Trajectory Format.
 *
 * Legacy format (version 1) is still supported for backward compatibility.
 * The v1.7 format adds richer metadata, structured steps, and vendor extensions.
 */

import type { SessionEntry, SessionHeader } from "./session-manager.ts";

// ============================================================================
// ATIF v1.7 Schema Types
// ============================================================================

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
		tool_definitions?: Array<{ name: string; description?: string }>;
	};
	/** Steps array */
	steps: AtifStep[];
	/** Optional notes */
	notes?: string;
	/** Optional final metrics */
	final_metrics?: {
		total_prompt_tokens: number;
		total_completion_tokens: number;
		total_cached_tokens: number;
		total_cost_usd?: number;
		total_steps: number;
	};
}

/** Legacy ATIF v1 trajectory (backward compatible) */
export interface AtifTrajectoryLegacy {
	format: "atif";
	version: 1;
	session: SessionHeader | null;
	entries: SessionEntry[];
}

/** Union type for all ATIF versions */
export type AtifTrajectory = AtifTrajectoryV17 | AtifTrajectoryLegacy | AtifTrajectoryV17Flat;

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
 * Export session as ATIF v1.7 flat-schema trajectory.
 * Uses a flat schema shape for interoperability with consumers expecting the flat layout.
 */
export function exportAtifV17Flat(sessionHeader: SessionHeader | null, entries: SessionEntry[]): AtifTrajectoryV17Flat {
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
		},
		steps: entriesToSteps(entries),
		...(messageCount > 0
			? {
					final_metrics: {
						total_prompt_tokens: 0,
						total_completion_tokens: 0,
						total_cached_tokens: 0,
						total_steps: messageCount,
					},
				}
			: {}),
	};
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
