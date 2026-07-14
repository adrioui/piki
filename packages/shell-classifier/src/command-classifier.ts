/**
 * Conservative classifier for long-running bash commands.
 *
 * Commands that match this classifier are candidates for auto-detach: they
 * spawn in their own process group, redirect output to a temp log, and return
 * pid/logpath immediately instead of blocking until exit.
 *
 * This is a pure function with no side effects.
 */

/**
 * Pattern pairs: [regex, description] for long-running command detection.
 * Patterns are tested against the full command string (after shell expansion
 * but before execution).
 */
const LONG_RUNNING_PATTERNS: ReadonlyArray<{ regex: RegExp; description: string }> = [
	// Dev server patterns
	{ regex: /\bnpm\s+run\s+dev\b/, description: "npm run dev" },
	{ regex: /\bnpx\s+.*\bdev\b/, description: "npx dev" },
	{ regex: /\bpnpm\s+run\s+dev\b/, description: "pnpm run dev" },
	{ regex: /\bpnpm\s+dev\b/, description: "pnpm dev" },
	{ regex: /\byarn\s+run\s+dev\b/, description: "yarn run dev" },
	{ regex: /\byarn\s+dev\b/, description: "yarn dev" },
	{ regex: /\bbun\s+run\s+dev\b/, description: "bun run dev" },
	{ regex: /\bbun\s+dev\b/, description: "bun dev" },

	// Known long-running tools
	{ regex: /\bvite\b/, description: "vite" },
	{ regex: /\bnext\s+dev\b/, description: "next dev" },
	{ regex: /\bnodemon\b/, description: "nodemon" },
	{ regex: /\bforever\b/, description: "forever" },
	{ regex: /\bpm2\b/, description: "pm2" },
	{ regex: /\bwebpack\s+serve\b/, description: "webpack serve" },
	{ regex: /\bwebpack\s+--watch\b/, description: "webpack --watch" },
	{ regex: /\brollup\s+.*-w\b/, description: "rollup -w" },
	{ regex: /\besbuild\s+.*--watch\b/, description: "esbuild --watch" },
	{ regex: /\bturbo\s+dev\b/, description: "turbo dev" },
	{ regex: /\blerna\s+.*\bwatch\b/, description: "lerna watch" },

	// Watch mode flags
	{ regex: /--watch\b/, description: "--watch flag" },
	{ regex: /\s-w\b(?!\w)/, description: "-w flag" },
	{ regex: /--continuous\b/, description: "--continuous flag" },
	{ regex: /--serve\b/, description: "--serve flag" },
	{ regex: /--daemon\b/, description: "--daemon flag" },
];

/**
 * Result of classifying a command.
 */
export interface CommandClassification {
	/** Whether the command is likely long-running. */
	longRunning: boolean;
	/** Description of why it was classified as long-running (or undefined if normal). */
	reason?: string;
}

/**
 * Classify a bash command as likely long-running or normal.
 *
 * This is conservative: it only flags commands that are very likely to run
 * indefinitely. Commands with explicit `timeout` parameters are not flagged
 * (the caller should check timeout before using this classifier).
 *
 * @param command - The bash command string to classify
 * @returns Classification result with reason
 */
export function classifyCommand(command: string): CommandClassification {
	const trimmed = command.trim();

	for (const { regex, description } of LONG_RUNNING_PATTERNS) {
		if (regex.test(trimmed)) {
			return { longRunning: true, reason: description };
		}
	}

	return { longRunning: false };
}
