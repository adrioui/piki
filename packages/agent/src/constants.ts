/**
 * Agent-level constants.
 */

// Token/character ratio bounds
export const CHARS_PER_TOKEN_UPPER = 4;
export const CHARS_PER_TOKEN_LOWER = 3;

// Truncation budget
export const TRUNCATION_TOKEN_LIMIT = 25_000;
export const TRUNCATION_CHAR_LIMIT = TRUNCATION_TOKEN_LIMIT * CHARS_PER_TOKEN_UPPER;

// Model output reserve
export const OUTPUT_TOKEN_RESERVE = 8192;

// UI
export const DEFAULT_CHAT_NAME = "New Chat";

// Compaction
export const COMPACT_MAX_FILES = 10;
export const COMPACT_MAX_FILE_CHARS = 1e4;
export const COMPACTION_MAX_RETRIES = 3;
export const COMPACTION_FALLBACK_KEEP_RATIO = 0.25;
export const KEEP_MESSAGE_RATIO = 0.1;
