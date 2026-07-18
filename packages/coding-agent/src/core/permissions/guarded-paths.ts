/**
 * Guarded path policy — Amp-style sensitive path protection.
 *
 * Mutating tools touching these paths require special handling regardless
 * of general tool permission rules.
 */

/**
 * Guarded path patterns (glob-style).
 * These paths are protected from mutation by default.
 */
/**
 * Tools that can mutate the filesystem / repo state. Guarded-path checks are
 * applied to these tools so workers and the leader share one definition.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
	"edit",
	"write",
	"bash",
	"shell",
	"edit-diff",
	"restore_snapshot",
	"checkpoint_rollback",
]);

export const GUARDED_PATH_PATTERNS: readonly string[] = [
	// Environment files
	"**/.env*",

	// SSH configuration
	"**/.ssh",
	"**/.ssh/**",

	// GPG keys
	"**/.gnupg",
	"**/.gnupg/**",

	// Kubernetes configs
	"**/.kube",
	"**/.kube/**",

	// Agent config directories
	"**/.claude",
	"**/.claude/**",
	"**/.codex",
	"**/.codex/**",
	"**/.cursor",
	"**/.cursor/**",
	"**/.windsurf",
	"**/.windsurf/**",
	"**/.amp",
	"**/.amp/**",

	// Taste profile files
	"**/.piki/taste/taste.md",
	"**/.piki/taste/**/taste.md",

	// System directories
	"/etc",
	"/etc/**",
	"/usr",
	"/usr/**",
	"/var",
	"/var/**",
	"/opt",
	"/opt/**",
];

export interface GuardedPathMatch {
	/** The path that was checked. */
	path: string;
	/** The pattern that matched. */
	pattern: string;
	/** Whether the path is guarded against mutation. */
	isGuarded: boolean;
}

/**
 * Check if a given path matches any guarded-path pattern.
 */
export function isGuardedPath(filePath: string): GuardedPathMatch | null {
	// Normalize the path: remove trailing slash, replace backslashes
	const normalized = filePath.replace(/\\/g, "/").replace(/\/$/, "");

	const isUnderVarHome = normalized === "/var/home" || normalized.startsWith("/var/home/");

	for (const pattern of GUARDED_PATH_PATTERNS) {
		// User home directories may live under /var on some distros (e.g., Fedora Silverblue).
		// Do not treat those as system paths from the /var/** system-dir patterns.
		if (isUnderVarHome && pattern.startsWith("/var")) {
			continue;
		}
		if (pathMatchesGlob(pattern, normalized)) {
			return { path: filePath, pattern, isGuarded: true };
		}
	}

	return null;
}

/**
 * Glob matching with ** support (matches across path separators).
 */
function pathMatchesGlob(pattern: string, filePath: string): boolean {
	// Build regex from glob pattern
	const regexStr = pattern
		.split(/(\*\*?|\?)/g)
		.map((part) => {
			if (part === "**") {
				return ".*";
			}
			if (part === "*") {
				return "[^/]*";
			}
			if (part === "?") {
				return ".";
			}
			return escapeGlobToRegex(part);
		})
		.join("")
		// Allow root-level matches: **/foo should also match foo with no leading directory
		.replace(/^\.\*\\\//, "(?:.*\\/)?");

	try {
		const re = new RegExp(`^${regexStr}$`);
		return re.test(filePath);
	} catch {
		return false;
	}
}

function escapeGlobToRegex(part: string): string {
	let result = "";
	for (let i = 0; i < part.length; i++) {
		const ch = part[i];
		if (ch === undefined) continue;
		if (ch === "*") {
			result += "[^/]*";
		} else if (ch === "?") {
			result += ".";
		} else if (/[.+^${}()|[\]\\]/.test(ch)) {
			result += `\\${ch}`;
		} else {
			result += ch;
		}
	}
	return result;
}

/**
 * Strip surrounding quotes from a token.
 */
function stripQuotes(token: string): string {
	if (
		token.length >= 2 &&
		((token[0] === '"' && token.at(-1) === '"') || (token[0] === "'" && token.at(-1) === "'"))
	) {
		return token.slice(1, -1);
	}
	return token;
}

/**
 * Extract file path candidates from a shell command string.
 * Tokenizes on whitespace and returns tokens that look like file paths
 * (do not start with `-` and are not shell operators).
 * Handles redirect targets attached to the operator (e.g., `>~/.ssh/key`).
 */
function extractPathsFromCommand(command: string): string[] {
	const paths: string[] = [];
	const tokens = command.split(/\s+/);
	for (const token of tokens) {
		if (!token) continue;
		// Skip flags and shell operators
		if (token === "|" || token === "&&" || token === "||" || token === ";") {
			continue;
		}
		// Skip env-var assignments (KEY=VALUE)
		if (/^[A-Za-z_]\w*=/.test(token)) {
			continue;
		}
		// Handle redirect operators with attached targets: >foo, >>foo, 2>foo, etc.
		const redirectMatch = /^\d*(>+)(.*)/.exec(token);
		if (redirectMatch) {
			const target = redirectMatch[2];
			if (target) {
				paths.push(stripQuotes(target));
			}
			continue;
		}
		// Skip bare input redirects without targets
		if (/^\d*</.test(token) && !token.includes(">")) {
			continue;
		}
		// Skip flags
		if (token.startsWith("-")) {
			continue;
		}
		paths.push(stripQuotes(token));
	}
	return paths;
}

/**
 * Check if a tool call input has file path arguments that hit guarded paths.
 * Returns the first guarded-path match found, or null if none.
 */
export function checkInputForGuardedPaths(args: Record<string, unknown>): GuardedPathMatch | null {
	// Check common file path keys
	const pathKeys = ["path", "filePath", "file_path", "targetPath", "target", "oldPath", "newPath"];
	for (const key of pathKeys) {
		const value = args[key];
		if (typeof value === "string") {
			const result = isGuardedPath(value);
			if (result) return result;
		}
	}

	// Check command string for file path references
	if (typeof args.command === "string") {
		const commandPaths = extractPathsFromCommand(args.command);
		for (const path of commandPaths) {
			const result = isGuardedPath(path);
			if (result) return result;
		}
	}

	return null;
}
