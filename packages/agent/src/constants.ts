/**
 * Agent-level constants.
 */

// Model output reserve
export const OUTPUT_TOKEN_RESERVE = 8192;

// Compaction trigger geometry (aligned with Magnitude alpha22).
// softCap = min(0.9 * (contextWindow - OUTPUT_TOKEN_RESERVE), SOFT_CAP_MAX_TOKENS)
export const SOFT_CAP_RATIO = 0.9;
export const SOFT_CAP_MAX_TOKENS = 200_000;

// UI
export const DEFAULT_CHAT_NAME = "New Chat";

// Compaction
export const COMPACTION_MAX_RETRIES = 3;
export const COMPACTION_FALLBACK_KEEP_RATIO = 0.25;
export const KEEP_MESSAGE_RATIO = 0.1;

// Per-tool execution safety timeouts.
// A hung tool (e.g. a shell command with no native timeout) would otherwise
// block the entire agent loop. The runtime enforces these via AbortSignal; the
// `shell`/`bash` tools get a longer budget because build/test/git legitimately
// run long, while all other tools are fast by nature.
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const SHELL_TOOL_TIMEOUT_MS = 120_000;
export const TOOL_TIMEOUT_BY_NAME: Record<string, number> = {
	shell: SHELL_TOOL_TIMEOUT_MS,
	bash: SHELL_TOOL_TIMEOUT_MS,
};
