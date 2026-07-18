/**
 * Shell command safety classifier.
 *
 * Parses common shell command structure so destructive commands are detected
 * across pipelines, separators, and command substitutions.
 */

import { resolve as resolvePath } from "node:path";

export type ShellSafetyLevel = "readonly" | "normal" | "mass-destructive" | "forbidden";

export interface ShellRedirect {
	op: string;
	target: string;
}

export interface ShellCommandSegment {
	name: string;
	args: string[];
	separatorBefore?: string;
	redirects?: ShellRedirect[];
	assignments?: { name: string; value: string }[];
}

export interface ShellClassification {
	level: ShellSafetyLevel;
	reason: string;
	command?: ShellCommandSegment;
}

const READONLY_COMMANDS = new Set([
	"cat",
	"cd",
	"echo",
	"find",
	"grep",
	"head",
	"less",
	"ls",
	"pwd",
	"rg",
	"tail",
	"test",
	"true",
	"wc",
	"which",
]);

const GIT_READONLY = new Set(["status", "log", "diff", "show", "rev-parse"]);
const GIT_UNSAFE_FLAGS = new Set(["--output", "--ext-diff", "--textconv", "--exec", "--paginate"]);
/** Attached `-c` form (e.g. `-cfoo=bar`): a git config override without a space. Mirrors mag `hasConfigOverride`. */
const isAttachedGitConfigFlag = (arg: string): boolean => arg.startsWith("-c") && arg.length > 2;
const GIT_FORBIDDEN = new Set(["stash"]);
const KUBECTL_FORBIDDEN = new Set([
	"apply",
	"create",
	"delete",
	"patch",
	"edit",
	"replace",
	"scale",
	"autoscale",
	"cordon",
	"uncordon",
	"drain",
	"taint",
	"run",
	"expose",
	"label",
	"annotate",
	"debug",
]);
const TERRAFORM_FORBIDDEN = new Set(["apply", "destroy", "import", "force-unlock", "taint", "untaint"]);
const DB_SHELLS = new Set(["mysql", "mariadb", "psql", "mongosh", "redis-cli", "mongo", "sqlcmd"]);
const SYSADMIN_ALWAYS_FORBIDDEN = new Set([
	"mkfs",
	"fdisk",
	"chroot",
	"useradd",
	"userdel",
	"usermod",
	"groupadd",
	"groupdel",
	"iptables",
	"nft",
	"ufw",
	"firewall-cmd",
	"shutdown",
	"reboot",
	"poweroff",
	"halt",
	"parted",
]);
const PACKAGE_MANAGERS = new Set(["apt", "apt-get", "yum", "dnf", "pacman", "snap", "brew"]);
/** Subcommands that make an OS package-manager invocation forbidden (mag PACKAGE_DESTRUCTIVE_TOKENS). */
const PACKAGE_DESTRUCTIVE_TOKENS = new Set([
	"remove",
	"purge",
	"autoremove",
	"dist-upgrade",
	"full-upgrade",
	"uninstall",
	"cleanup",
]);
/** Broad process names that make a hard-kill pkill/killall forbidden (mag PKILL_BROAD_NAMES). */
const PKILL_BROAD_NAMES = new Set(["node", "python", "java", "sh"]);
const SENSITIVE_MOUNT_PATHS = [
	"/var/run/docker.sock",
	"/etc",
	"/root",
	"/.ssh",
	".ssh",
	"/.aws",
	".aws",
	"/.config/gcloud",
	".config/gcloud",
	"/.azure",
	".azure",
];

/**
 * Language/runtime package managers whose publish / rebuild / global-install /
 * remove operations can mutate shared or remote state. Mirrors Magnitude
 * alpha22's `LANG_PACKAGE_MANAGERS` + `PACKAGE_MANAGERS` blocklist.
 */
const LANG_PACKAGE_MANAGERS = new Set([
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"twine",
	"poetry",
	"uv",
	"cargo",
	"gem",
	"mvn",
	"gradle",
	"gradlew",
	"dotnet",
	"mix",
	"swift",
]);

/** Subcommands/flags that make a package-manager invocation forbidden. */
const PACKAGE_MANAGER_FORBIDDEN_SUBCOMMANDS = new Set([
	"publish",
	"unpublish",
	"rebuild",
	"remove",
	"uninstall",
	"unlink",
	"login",
	"logout",
	"depublish",
	"upload",
]);

/**
 * Return true when a package-manager command performs a risky state mutation
 * (publish, rebuild, global install, remove) — alpha22
 * `isLangPackageManagerForbidden`. Read-style subcommands (install, add, run,
 * build, test, info) are allowed.
 */
function isLangPackageManagerForbidden(manager: string, args: string[]): boolean {
	if (args.length === 0) return false;
	// Positional args after the manager name (strip flags + lowercase), matching
	// mag's `positionalArgs`. mag lowercases every positional token, so we do too
	// to catch case-variant publish commands (e.g. `gem --silent Push`,
	// `Gradle clean Publish`). A value-consuming flag like `--silent Push` must
	// NOT consume the next token as a value here — the flag-stripped positional
	// list keeps `push` as the subcommand, exactly like mag.
	const pos = args.filter((a) => !a.startsWith("-")).map((a) => a.toLowerCase());
	const subcommand = pos[0];
	if (!subcommand) return false;
	// Preserve piki-stricter blocks (G-PM2): mag allows these, piki does not.
	if (PACKAGE_MANAGER_FORBIDDEN_SUBCOMMANDS.has(subcommand)) return true;
	// Preserve piki --global heuristic (install/add/link/cache + --global/-g).
	if (
		args.some((arg) => arg === "--global" || arg === "-g" || arg.endsWith("-g") || /^-[A-Za-z]*g[A-Za-z]*$/.test(arg))
	) {
		if (subcommand === "install" || subcommand === "add" || subcommand === "link" || subcommand === "cache") {
			return true;
		}
	}
	const npmLikeForbidden = (p: string[]): boolean => {
		if (p.length === 0) return false;
		const f = p[0]!;
		if (["publish", "unpublish", "deprecate", "adduser", "login", "star", "unstar"].includes(f)) return true;
		if (f === "dist-tag" && (p[1] === "add" || p[1] === "rm" || p[1] === "remove")) return true;
		if (f === "owner" && (p[1] === "add" || p[1] === "rm" || p[1] === "remove")) return true;
		if (f === "access" && ["grant", "revoke", "public", "restricted"].includes(p[1]!)) return true;
		if (f === "org" && (p[1] === "set" || p[1] === "rm")) return true;
		if (f === "team" && ["create", "destroy", "add", "rm"].includes(p[1]!)) return true;
		if (f === "token" && (p[1] === "create" || p[1] === "revoke")) return true;
		if (f === "hook" && (p[1] === "add" || p[1] === "update" || p[1] === "rm")) return true;
		return false;
	};
	const cargoGemOwner = (a: string[]) => subcommand === "owner" && (a.includes("--add") || a.includes("--remove"));
	// mag lowercases the base manager name before matching (b2 = base.toLowerCase()),
	// so case-variant manager invocations (e.g. `Gradle`, `Npm`) are caught.
	switch (manager.toLowerCase()) {
		case "npm":
		case "pnpm":
			return npmLikeForbidden(pos);
		case "yarn":
			return (
				pos[0] === "publish" ||
				pos[0] === "login" ||
				(pos[0] === "owner" && (pos[1] === "add" || pos[1] === "remove" || pos[1] === "rm")) ||
				(pos[0] === "tag" && (pos[1] === "add" || pos[1] === "remove" || pos[1] === "rm")) ||
				(pos[0] === "npm" &&
					(["publish", "login"].includes(pos[1]!) ||
						(pos[1] === "owner" && (pos[2] === "add" || pos[2] === "remove" || pos[2] === "rm")) ||
						(pos[1] === "tag" && (pos[2] === "add" || pos[2] === "remove" || pos[2] === "rm"))))
			);
		case "bun":
			return pos[0] === "publish";
		case "twine":
			return pos[0] === "upload";
		case "poetry":
		case "uv":
			return pos[0] === "publish";
		case "cargo":
			return pos[0] === "publish" || pos[0] === "yank" || cargoGemOwner(args);
		case "gem":
			return pos[0] === "push" || pos[0] === "yank" || cargoGemOwner(args);
		case "mvn":
			return pos[0] === "deploy";
		case "gradle":
		case "gradlew":
			for (const token of pos) {
				if (token === "publishtomavenlocal") continue;
				if (token === "publish" || token.startsWith("publish")) return true;
			}
			return false;
		case "dotnet":
			return pos[0] === "nuget" && (pos[1] === "push" || pos[1] === "delete");
		case "mix":
			return (
				pos[0] === "hex.publish" ||
				pos[0] === "hex.retire" ||
				(pos[0] === "hex.owner" && (pos[1] === "add" || pos[1] === "remove" || pos[1] === "transfer"))
			);
		case "swift":
			return pos[0] === "package-registry" && pos[1] === "publish";
		default:
			return false;
	}
}

function basename(command: string): string {
	const normalized = command.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function tokenize(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | "`" | undefined;
	let parenDepth = 0;

	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		const next = command[i + 1];

		if (quote) {
			current += char;
			if (char === "\\" && quote !== "'") {
				if (next !== undefined) current += command[++i]!;
				continue;
			}
			if (char === quote) quote = undefined;
			continue;
		}

		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			current += char;
			continue;
		}

		if (char === "$" && next === "(") {
			parenDepth++;
			current += "$(";
			i++;
			continue;
		}
		if (char === "(" && parenDepth > 0) {
			parenDepth++;
			current += char;
			continue;
		}
		if (char === ")" && parenDepth > 0) {
			parenDepth--;
			current += char;
			continue;
		}

		if (parenDepth === 0 && /\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		if (parenDepth === 0) {
			if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
				if (current) {
					tokens.push(current);
					current = "";
				}
				tokens.push(`${char}${next}`);
				i++;
				continue;
			}
			if (char === "|" || char === ";") {
				if (current) {
					tokens.push(current);
					current = "";
				}
				tokens.push(char);
				continue;
			}
		}

		current += char;
	}

	if (current) tokens.push(current);
	return tokens;
}

export function parseShellCommand(command: string): ShellCommandSegment[] {
	const tokens = tokenize(command);
	const segments: ShellCommandSegment[] = [];
	let current: string[] = [];
	let separatorBefore: string | undefined;
	let pendingAssignments: { name: string; value: string }[] = [];

	for (const token of tokens) {
		if (token === "|" || token === "&&" || token === "||" || token === ";") {
			if (current.length > 0) {
				segments.push(buildSegment(current, pendingAssignments, separatorBefore));
				current = [];
				pendingAssignments = [];
			}
			separatorBefore = token;
			continue;
		}
		// Leading `NAME=value` env-var assignments before the command name.
		if (current.length === 0 && !token.startsWith("-") && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
			const eq = token.indexOf("=");
			pendingAssignments.push({ name: token.slice(0, eq), value: token.slice(eq + 1) });
			continue;
		}
		current.push(token);
	}

	if (current.length > 0) {
		segments.push(buildSegment(current, pendingAssignments, separatorBefore));
	}

	return segments;
}

/**
 * Build a command segment from the collected tokens (command name + args).
 *
 * Extends the segment with `redirects`/`assignments` but ONLY when non-empty,
 * so the default shape for plain commands stays exactly
 * `{ name, args, separatorBefore }` (backward-compat with existing tests).
 */
function buildSegment(
	tokens: string[],
	assignments: { name: string; value: string }[],
	separatorBefore?: string,
): ShellCommandSegment {
	const redirects = extractRedirects(tokens);
	const segment: ShellCommandSegment = {
		name: basename(tokens[0]!),
		args: tokens.slice(1),
	};
	if (separatorBefore !== undefined) segment.separatorBefore = separatorBefore;
	if (redirects.length > 0) segment.redirects = redirects;
	if (assignments.length > 0) segment.assignments = assignments;
	return segment;
}

const REDIRECT_OPS = new Set([">", ">>", ">&", "&>", "<", "<<", "<<<", "<(", "2>", "1>", "2>>", "1>>"]);

/**
 * Second-pass redirect extraction over the flat token list.
 *
 * Mirrors Magnitude alpha22's tokenizer: a redirect operator token followed by
 * a whitespace-separated Word (the target, quote-stripped) forms a redirect.
 * The operator and target are NOT removed from `args` (alpha22 leaves them in
 * the token stream too), so `classifyShellCommand` continues to see the full
 * command.
 */
function extractRedirects(tokens: string[]): ShellRedirect[] {
	const redirects: ShellRedirect[] = [];
	for (let i = 0; i < tokens.length - 1; i++) {
		const token = tokens[i]!;
		if (!isRedirectOp(token)) continue;
		const target = stripQuotes(tokens[i + 1]!);
		redirects.push({ op: token, target });
		i++; // consume the target token with the operator
	}
	return redirects;
}

/**
 * Redirect operators (with optional fd prefix like `1>`, `2>>`).
 */
function isRedirectOp(token: string): boolean {
	// Strip a leading single digit fd prefix (e.g. "2>", "1>>").
	const body = /^\d+/.test(token) ? token.replace(/^\d+/, "") : token;
	if (REDIRECT_OPS.has(body)) return true;
	// Numeric-fd form "3>&1", "1>&2" etc.
	if (/^&?\d+$/.test(body) && (token.includes(">&") || token.includes("&>"))) return true;
	return REDIRECT_OPS.has(token);
}

function stripQuotes(token: string): string {
	const quote = token[0];
	if ((quote === "'" || quote === '"') && token.endsWith(quote) && token.length > 1) {
		return token.slice(1, -1);
	}
	return token;
}

function extractCommandSubstitutions(command: string): string[] {
	const substitutions: string[] = [];
	for (let i = 0; i < command.length; i++) {
		if (command[i] !== "$" || command[i + 1] !== "(") continue;
		let depth = 1;
		let content = "";
		i += 2;
		for (; i < command.length; i++) {
			const char = command[i]!;
			if (char === "(") depth++;
			if (char === ")") depth--;
			if (depth === 0) break;
			content += char;
		}
		if (content.trim()) substitutions.push(content);
	}
	return substitutions;
}

function includesAnyArg(args: string[], values: string[]): boolean {
	return args.some((arg) => values.includes(arg) || values.some((value) => arg.startsWith(`${value}=`)));
}

function hasSensitiveMount(args: string[]): boolean {
	return args.some((arg, index) => {
		const prev = args[index - 1];
		const mountArg =
			prev === "-v" ||
			prev === "--volume" ||
			prev === "--mount" ||
			arg.startsWith("-v") ||
			arg.startsWith("--volume=") ||
			arg.startsWith("--mount=");
		return mountArg && SENSITIVE_MOUNT_PATHS.some((path) => arg.includes(path));
	});
}

function gitCleanDeletesDirectories(args: string[]): boolean {
	let hasForce = false;
	let hasDirectory = false;
	for (const arg of args) {
		if (arg === "--force" || arg === "-f" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("f"))) {
			hasForce = true;
		}
		if (arg === "-d" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("d"))) {
			hasDirectory = true;
		}
	}
	return hasForce && hasDirectory;
}

/**
 * Locate the git subcommand, skipping global options and their values.
 *
 * Git global options consume a value: `-C <path>`, `--git-dir <path>`,
 * `--work-tree <path>`, `-c <key=value>`, `--config-env <name>=<envvar>`.
 * Both detached (`-C /dir`) and attached (`-C/dir`, `--git-dir=/dir`) forms
 * are recognized so the subcommand after them is not mistaken for one of these
 * option values. For example `git -C /dir status` resolves to `status`, not the
 * path. Returns undefined when no subcommand token remains.
 */
const GIT_GLOBAL_OPTION_TAKES_VALUE = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--config-env",
	"--exec-path",
	"--namespace",
	"--super-prefix",
]);

function findGitSubcommand(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!arg.startsWith("-")) return arg;
		// Attached value form: --git-dir=/dir, -C/dir (a value is glued on).
		if (arg.includes("=")) continue;
		if (/^-[A-Za-z]./.test(arg)) continue;
		// Detached value form: -C /dir, --git-dir /dir (consume next arg).
		if (GIT_GLOBAL_OPTION_TAKES_VALUE.has(arg)) {
			i++;
		}
	}
	return undefined;
}

const GIT_BRANCH_READONLY_FLAGS = new Set([
	"--list",
	"-l",
	"--show-current",
	"-a",
	"--all",
	"-r",
	"--remotes",
	"-v",
	"-vv",
	"--verbose",
	"--format=",
]);

/**
 * Mirror Magnitude alpha22's `branchIsReadOnly`: a `git branch` is read-only
 * only when every operand is a recognized read-only flag (e.g. `-a`, `-r`,
 * `--show-current`, `--format=...`). Any other operand (e.g.
 * `--set-upstream-to=`, `-u`, `-m`, `-d`, `-c`) makes it a mutation. An empty
 * operand list is treated as read-only.
 */
function branchIsReadOnlyLike(args: string[]): boolean {
	const post = args.slice(args.indexOf("branch") + 1);
	if (post.length === 0) return true;
	for (const arg of post) {
		if (GIT_BRANCH_READONLY_FLAGS.has(arg) || arg.startsWith("--format=")) continue;
		return false;
	}
	return true;
}

function classifyGit(args: string[]): ShellClassification | undefined {
	const subcommand = findGitSubcommand(args);
	// Config/execution-affecting flags are forbidden even for otherwise
	// read-only subcommands (alpha22: `git -c user.name=x status` and
	// `git status --output=f` are mutating). Global options that swallow a value
	// are skipped by findGitSubcommand, so flags here are inline overrides.
	const isAttachedC = (arg: string): boolean => arg.startsWith("-c") && arg.length > 2;
	const hasUnsafeGitFlag = (flags: string[]) =>
		flags.includes("-c") ||
		flags.includes("--config-env") ||
		flags.some(
			(arg) =>
				isAttachedC(arg) ||
				arg.startsWith("--config-env=") ||
				GIT_UNSAFE_FLAGS.has(arg) ||
				(arg.includes("=") && GIT_UNSAFE_FLAGS.has(arg.split("=")[0]!)),
		);
	if (hasUnsafeGitFlag(args)) {
		return { level: "forbidden", reason: "git command uses config or execution-affecting flags" };
	}
	if (subcommand && !GIT_READONLY.has(subcommand)) {
		if (
			args.includes("-c") ||
			args.some(
				(arg) => GIT_UNSAFE_FLAGS.has(arg) || (arg.includes("=") && GIT_UNSAFE_FLAGS.has(arg.split("=")[0]!)),
			)
		) {
			return { level: "forbidden", reason: "git command uses config or execution-affecting flags" };
		}
	}
	if (!subcommand) return { level: "normal", reason: "git command without read-only subcommand" };
	if (GIT_READONLY.has(subcommand)) return { level: "readonly", reason: "read-only git command" };
	if (subcommand === "branch") {
		return branchIsReadOnlyLike(args)
			? { level: "readonly", reason: "read-only git branch command" }
			: {
					level: "forbidden",
					reason: "git branch mutation (e.g. --set-upstream-to, rename, copy, delete) is blocked",
				};
	}
	if (GIT_FORBIDDEN.has(subcommand)) {
		return { level: "forbidden", reason: `Destructive git ${subcommand} can mutate repository state` };
	}
	if (subcommand === "add" && (args.includes("-A") || args.includes("--all") || args.includes("."))) {
		return { level: "forbidden", reason: "git add all paths is blocked" };
	}
	if (subcommand === "commit" && args.includes("--no-verify")) {
		return { level: "forbidden", reason: "git commit --no-verify bypasses repository checks" };
	}
	if (subcommand === "push" && args.some((arg) => arg === "-f" || arg === "--force" || arg === "--force-with-lease")) {
		return { level: "forbidden", reason: "git force push can overwrite remote history" };
	}
	if (subcommand === "reset" && args.includes("--hard")) {
		return { level: "forbidden", reason: "git reset --hard can discard uncommitted changes" };
	}
	if (subcommand === "clean" && gitCleanDeletesDirectories(args)) {
		return { level: "forbidden", reason: "git clean -fd can delete untracked files and directories" };
	}
	// Destructive git restore: `git restore .` or `git restore -- <paths>`
	if (subcommand === "restore" && (args.includes(".") || args.includes("--"))) {
		return { level: "forbidden", reason: "git restore can discard uncommitted changes" };
	}
	// Destructive git checkout: `git checkout .` or `git checkout -- <paths>`
	if (subcommand === "checkout" && (args.includes(".") || args.includes("--"))) {
		return { level: "forbidden", reason: "git checkout can discard uncommitted changes" };
	}
	return { level: "normal", reason: "git command may mutate repository state" };
}

/**
 * Return true when a git segment is not an explicitly read-only operation.
 *
 * Aligned to Magnitude alpha22's strict read-only allowlist: only
 * `status`, `log`, `diff`, `show`, `rev-parse`, and a read-only `branch`
 * (no operands / no mutation flags) are permitted. Every other git command
 * (including `ls-files`, `blame`, `grep`, `tag -l`, `config --get`,
 * `remote -v`, etc.) is treated as a mutation and blocked.
 *
 * Global options that consume a value (`-C`, `-c`, `--git-dir`,
 * `--work-tree`, `--config-env`, both detached and attached forms) are
 * skipped. However, inline config overrides (`-c key=val`, `--config-env`)
 * and execution/output unsafe flags (`--output`, `--exec`, `--ext-diff`,
 * `--textconv`, `--paginate`) attached to ANY subcommand (including otherwise
 * read-only ones) make the command mutating, matching alpha22. So
 * `git -c user.name=x status` is a mutation, as is `git status --output=f`,
 * while `git -c user.name=x commit` remains a mutation because the
 * subcommand itself is `commit`.
 */
export function isGitMutation(command: string): boolean {
	for (const segment of parseShellCommand(command)) {
		if (basename(segment.name) !== "git") continue;
		const args = segment.args;
		const subcommand = findGitSubcommand(args);
		if (!subcommand) return true;
		// alpha22: config overrides (`-c`, `--config-env`) and execution/output
		// unsafe flags (`--output`, `--exec`, `--ext-diff`, `--textconv`,
		// `--paginate`, and their `=`-valued forms) make ANY git command
		// mutating, even an otherwise read-only subcommand such as
		// `git -c user.name=x status` or `git status --output=f`.
		const isUnsafeGitFlag = (arg: string): boolean =>
			arg === "-c" ||
			arg === "--config-env" ||
			arg.startsWith("--config-env=") ||
			isAttachedGitConfigFlag(arg) ||
			GIT_UNSAFE_FLAGS.has(arg) ||
			(arg.includes("=") && GIT_UNSAFE_FLAGS.has(arg.split("=")[0]!));
		if (args.some(isUnsafeGitFlag)) return true;
		if (subcommand === "branch") {
			// Read-only branch: no operands and no mutation flags. Strip global
			// options so an inline `-c key=val` override is not mistaken for the
			// branch copy flag `-c`.
			if (branchIsReadOnlyLike(args)) return false;
			return true;
		}
		const READONLY = new Set(["status", "log", "diff", "show", "rev-parse"]);
		if (READONLY.has(subcommand)) continue;
		return true;
	}
	return false;
}

// ─── Magnitude alpha22 cwd-boundary parity ───
//
// Mirrors alpha22's `writesStayWithin` / `denyWritesOutside` shell write-boundary
// enforcement. A shell command is rejected when any redirect target or any
// argument of a write-path command resolves (after ~ / $M / $HOME / $PROJECT_ROOT
// expansion and per-command `cd` effective-cwd tracking) outside the allowed roots
// [cwd, scratchpadPath, ~/.piki]. piki's stronger mass-destructive / git blocking
// runs BEFORE this check (see permission-gate.ts), so this only adds the boundary
// layer and never weakens existing safety.

export const WRITE_PATH_COMMANDS = new Set([
	"rm",
	"cp",
	"mv",
	"tee",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"ln",
	"install",
	"rsync",
]);

const ALLOWED_OUTSIDE_PREFIXES = ["/tmp/", "/dev/null"];

/** Expand `${VAR}` / `$VAR` via the provided env mapping. */
export function expandEnvVars(p: string, env: Record<string, string>): string {
	return p.replace(/\$\{(\w+)\}|\$(\w+)/g, (_match, braced, bare) => {
		const key = (braced ?? bare) as string;
		return env[key] ?? "";
	});
}

/**
 * Expand `~` / `$VAR` / `${VAR}` and resolve against `baseCwd`.
 * Mirrors alpha22 `expandAndResolve`: tilde expands to `$HOME`/`$USERPROFILE`,
 * otherwise resolve relative to `baseCwd` (with a trailing slash trimmed).
 */
export function expandAndResolve(path: string, env: Record<string, string>, baseCwd: string): string {
	const expanded = expandEnvVars(path, env);
	if (expanded.startsWith("~")) {
		const home = env.HOME ?? env.USERPROFILE ?? "";
		return resolvePath(home, expanded.slice(expanded.startsWith("~/") ? 2 : 1));
	}
	const baseNoSlash = baseCwd.endsWith("/") ? baseCwd.slice(0, -1) : baseCwd;
	return resolvePath(baseNoSlash, expanded);
}

/**
 * True when `path` is empty, dash-prefixed, resolves under any allowed root, or
 * starts with an allowed-outside prefix (`/tmp/`, `/dev/null`). Mirrors alpha22
 * `isPathWithin`.
 */
export function isPathWithin(path: string, env: Record<string, string>, ...allowedRoots: string[]): boolean {
	if (!path || path.startsWith("-")) return true;
	const [primaryRoot, ...additionalRoots] = allowedRoots;
	const cwd = primaryRoot ?? process.cwd();
	const normalizedCwd = cwd.endsWith("/") ? cwd : `${cwd}/`;
	const cwdNoSlash = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
	const resolved = expandAndResolve(path, env, cwdNoSlash);
	if (resolved === cwdNoSlash || resolved.startsWith(normalizedCwd)) return true;
	const explicitRoots = [cwd, ...additionalRoots];
	if (
		explicitRoots.some((root) => {
			const normalizedRoot = root.endsWith("/") ? `${root}/` : root;
			const rootNoSlash = root.endsWith("/") ? root.slice(0, -1) : root;
			return resolved === rootNoSlash || resolved.startsWith(normalizedRoot);
		})
	) {
		return true;
	}
	if (ALLOWED_OUTSIDE_PREFIXES.some((prefix) => resolved === prefix.slice(0, -1) || resolved.startsWith(prefix))) {
		return true;
	}
	return false;
}

/**
 * Enforce that all shell write targets stay within the allowed roots.
 * Mirrors alpha22 `writesStayWithin`. Tracks effective cwd across `cd` (incl.
 * `cd` with no arg -> $HOME, `cd -` -> previous cwd). Returns true when the
 * command is allowed, false when a write target lands outside the roots.
 */
export function writesStayWithin(command: string, env: Record<string, string>, ...allowedRoots: string[]): boolean {
	const initialCwd = allowedRoots[0] ?? process.cwd();
	let effectiveCwd = initialCwd;
	let previousCwd: string | null = null;

	for (const cmd of parseShellCommand(command)) {
		if (cmd.name) {
			const name = basename(cmd.name);
			if (name === "cd") {
				const oldCwd = effectiveCwd;
				const target = cmd.args[0];
				let resolvedTarget: string;
				if (!target) {
					const home = env.HOME ?? env.USERPROFILE;
					if (!home) return false;
					resolvedTarget = expandAndResolve(home, env, effectiveCwd);
				} else if (target === "-") {
					if (!previousCwd) return false;
					resolvedTarget = previousCwd;
				} else {
					// alpha22 returns false for undefined env vars / missing HOME with `~`.
					if (hasUndefinedEnvVars(target, env)) return false;
					if (target.startsWith("~") && !env.HOME && !env.USERPROFILE) return false;
					resolvedTarget = expandAndResolve(target, env, effectiveCwd);
				}
				previousCwd = oldCwd;
				effectiveCwd = resolvedTarget;
				continue;
			}
		}

		for (const redir of cmd.redirects ?? []) {
			const resolvedTarget = expandAndResolve(redir.target, env, effectiveCwd);
			if (!isPathWithin(resolvedTarget, env, ...allowedRoots)) return false;
		}

		if (cmd.name) {
			const name = basename(cmd.name);
			if (WRITE_PATH_COMMANDS.has(name)) {
				for (const arg of cmd.args) {
					if (arg.startsWith("-")) continue;
					const resolvedArg = expandAndResolve(arg, env, effectiveCwd);
					if (!isPathWithin(resolvedArg, env, ...allowedRoots)) return false;
				}
			}
		}
	}

	return true;
}

/**
 * Strict variant of `writesStayWithin` that does NOT honor the
 * `ALLOWED_OUTSIDE_PREFIXES` (/tmp, /dev/null) exemption. Used for
 * mass-destructive protection (alpha22 `denyMassDestructiveIn`): a
 * mass-destructive command such as `rm -rf /tmp/x` is rejected even though
 * `/tmp` is normally allowed for ordinary writes.
 */
export function writesStayWithinStrict(
	command: string,
	env: Record<string, string>,
	...allowedRoots: string[]
): boolean {
	const initialCwd = allowedRoots[0] ?? process.cwd();
	let effectiveCwd = initialCwd;
	let previousCwd: string | null = null;

	for (const cmd of parseShellCommand(command)) {
		if (cmd.name) {
			const name = basename(cmd.name);
			if (name === "cd") {
				const oldCwd = effectiveCwd;
				const target = cmd.args[0];
				let resolvedTarget: string;
				if (!target) {
					const home = env.HOME ?? env.USERPROFILE;
					if (!home) return false;
					resolvedTarget = expandAndResolve(home, env, effectiveCwd);
				} else if (target === "-") {
					if (!previousCwd) return false;
					resolvedTarget = previousCwd;
				} else {
					if (hasUndefinedEnvVars(target, env)) return false;
					if (target.startsWith("~") && !env.HOME && !env.USERPROFILE) return false;
					resolvedTarget = expandAndResolve(target, env, effectiveCwd);
				}
				previousCwd = oldCwd;
				effectiveCwd = resolvedTarget;
				continue;
			}
		}

		for (const redir of cmd.redirects ?? []) {
			const resolvedTarget = expandAndResolve(redir.target, env, effectiveCwd);
			if (!isPathWithinStrict(resolvedTarget, env, ...allowedRoots)) return false;
		}

		if (cmd.name) {
			const name = basename(cmd.name);
			if (WRITE_PATH_COMMANDS.has(name)) {
				for (const arg of cmd.args) {
					if (arg.startsWith("-")) continue;
					const resolvedArg = expandAndResolve(arg, env, effectiveCwd);
					if (!isPathWithinStrict(resolvedArg, env, ...allowedRoots)) return false;
				}
			}
		}
	}

	return true;
}

/** Like `isPathWithin` but without the /tmp, /dev/null outside-prefix exemption. */
function isPathWithinStrict(path: string, env: Record<string, string>, ...allowedRoots: string[]): boolean {
	if (!path || path.startsWith("-")) return true;
	const [primaryRoot, ...additionalRoots] = allowedRoots;
	const cwd = primaryRoot ?? process.cwd();
	const normalizedCwd = cwd.endsWith("/") ? cwd : `${cwd}/`;
	const cwdNoSlash = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
	const resolved = expandAndResolve(path, env, cwdNoSlash);
	if (resolved === cwdNoSlash || resolved.startsWith(normalizedCwd)) return true;
	const explicitRoots = [cwd, ...additionalRoots];
	if (
		explicitRoots.some((root) => {
			const normalizedRoot = root.endsWith("/") ? `${root}/` : root;
			const rootNoSlash = root.endsWith("/") ? root.slice(0, -1) : root;
			return resolved === rootNoSlash || resolved.startsWith(normalizedRoot);
		})
	) {
		return true;
	}
	return false;
}

/** True when a token contains a `$VAR` reference that is not present in env. */
function hasUndefinedEnvVars(token: string, env: Record<string, string>): boolean {
	return /\$\{(\w+)\}|\$(\w+)/.test(token) && !/\$\{(\w+)\}|\$(\w+)/.test(expandEnvVars(token, env));
}

/** Container run flags that disable the sandbox; case-insensitive (mag SECURITY_OPT_RISK_VALUES). */
const SECURITY_OPT_RISK_VALUES = new Set(["seccomp=unconfined", "apparmor=unconfined"]);
function hasUnconfinedSecurityOpt(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (token === "--security-opt") {
			const value = args[i + 1]?.toLowerCase();
			if (value !== undefined && SECURITY_OPT_RISK_VALUES.has(value)) return true;
			continue;
		}
		if (token.startsWith("--security-opt=")) {
			const value = token.slice("--security-opt=".length).toLowerCase();
			if (SECURITY_OPT_RISK_VALUES.has(value)) return true;
		}
	}
	return false;
}

/** Destructive `docker compose down` flags (mag COMPOSE_DESTRUCTIVE_FLAGS). */
const COMPOSE_DESTRUCTIVE_FLAGS = new Set(["-v", "--volumes", "--rmi", "--remove-orphans"]);
const isOptToken = (t: string): boolean => t.startsWith("-") && !/^-\d+$/.test(t);
function isComposeDownWithDestructiveFlags(args: string[]): boolean {
	const ci = args.findIndex((a) => a === "compose" || a === "compose.exe");
	if (ci === -1) return false;
	let i = ci + 1;
	while (i < args.length) {
		const t = args[i]!;
		if (!isOptToken(t)) break;
		// A flag without "=" consumes the following value token.
		if (!t.includes("=")) i += 2;
		else i += 1;
	}
	const sub = args[i]?.toLowerCase();
	if (sub !== "down") return false;
	return args.some((a) => COMPOSE_DESTRUCTIVE_FLAGS.has(a));
}

function classifyContainer(name: string, args: string[]): ShellClassification | undefined {
	if (name !== "docker" && name !== "podman" && name !== "nerdctl") return undefined;
	if (args.some((arg) => ["login", "logout", "push"].includes(arg))) {
		return { level: "forbidden", reason: `${name} remote credential or push operation is blocked` };
	}
	if (args.includes("prune")) return { level: "forbidden", reason: `${name} prune can remove many resources` };
	if (
		includesAnyArg(args, [
			"--privileged",
			"--pid=host",
			"--ipc=host",
			"--uts=host",
			"--userns=host",
			"--net=host",
			"--network=host",
		])
	) {
		return { level: "forbidden", reason: `${name} command requests privileged or host namespace access` };
	}
	if (args.some((arg) => arg.toLowerCase() === "--cap-add=all" || arg.toLowerCase() === "--cap-add=sys_admin")) {
		return { level: "forbidden", reason: `${name} command adds dangerous Linux capabilities` };
	}
	if (hasUnconfinedSecurityOpt(args)) {
		return {
			level: "forbidden",
			reason: `${name} command disables container sandboxing (seccomp/apparmor unconfined)`,
		};
	}
	if (isComposeDownWithDestructiveFlags(args)) {
		return {
			level: "forbidden",
			reason: `${name} compose down with volume/resource-destroying flags is blocked`,
		};
	}
	if (hasSensitiveMount(args)) {
		return { level: "forbidden", reason: `${name} command mounts sensitive host paths` };
	}
	return { level: "normal", reason: `${name} command requires normal shell permission` };
}

function findSubcommandAfterFlags(args: string[]): string | undefined {
	// Skip flags and their values. Flags that take a value are those with
	// no = sign that are followed by a non-flag argument.
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (arg.startsWith("-")) {
			// Flags with = or long-form flags like --namespace=value don't consume the next arg
			if (!arg.includes("=")) {
				skipNext = true;
			}
			continue;
		}
		return arg;
	}
	return undefined;
}

function classifyKubectl(args: string[]): ShellClassification | undefined {
	const subcommand = findSubcommandAfterFlags(args);
	if (!subcommand) return { level: "normal", reason: "kubectl command without read-only subcommand" };
	if (KUBECTL_FORBIDDEN.has(subcommand)) {
		return { level: "forbidden", reason: `kubectl ${subcommand} mutates cluster state` };
	}
	const subcommand2 = args.find((arg, index) => index > args.indexOf(subcommand) && !arg.startsWith("-"));
	if (subcommand === "set" && subcommand2) {
		return { level: "forbidden", reason: `kubectl ${subcommand} mutates resource configuration` };
	}
	if (subcommand === "auth" && subcommand2 === "reconcile") {
		return { level: "forbidden", reason: "kubectl auth reconcile mutates RBAC resources" };
	}
	if (subcommand === "certificate" && (subcommand2 === "approve" || subcommand2 === "deny")) {
		return { level: "forbidden", reason: "kubectl certificate approve/deny mutates certificate state" };
	}
	if (includesAnyArg(args, ["--force", "--grace-period=0", "--all", "-A", "-a", "--all-namespaces"])) {
		return { level: "forbidden", reason: "kubectl command broadens blast radius or forces changes" };
	}
	if (subcommand === "rollout" && args.some((arg) => ["restart", "undo", "pause", "resume"].includes(arg))) {
		return { level: "forbidden", reason: "kubectl rollout operation mutates workloads" };
	}
	return ["get", "describe", "logs", "top", "version"].includes(subcommand)
		? { level: "readonly", reason: "read-only kubectl command" }
		: { level: "normal", reason: "kubectl command requires normal shell permission" };
}

const GCLOUD_VALUE_FLAGS = new Set([
	"--project",
	"--account",
	"--configuration",
	"--impersonate-service-account",
	"--billing-project",
	"--format",
]);

/**
 * Compute the gcloud command path, skipping global flags and the values of
 * value-taking global flags (mag `cloudCommandPath` +
 * `GCLOUD_GLOBAL_FLAGS_WITH_VALUE`). Both attached (`--project=foo`) and
 * detached (`--project foo`) forms are skipped, as are short forms (`-p foo`).
 * Without this, `gcloud --project foo auth activate-service-account` would
 * resolve its path to `["foo","auth",...]` and miss the `auth` gate.
 */
function gcloudCommandPath(args: string[]): string[] {
	const path: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq >= 0) {
				const flag = a.slice(0, eq);
				if (GCLOUD_VALUE_FLAGS.has(flag)) continue;
				path.push(a);
				continue;
			}
			if (GCLOUD_VALUE_FLAGS.has(a)) {
				i++;
				continue;
			}
			path.push(a);
			continue;
		}
		if (a.startsWith("-") && a.length > 2 && GCLOUD_VALUE_FLAGS.has(a.slice(0, 2))) {
			i++;
			continue;
		}
		path.push(a);
	}
	return path;
}

const AWS_MUTATING_PREFIXES = [
	"create-",
	"delete-",
	"update-",
	"modify-",
	"put-",
	"remove-",
	"terminate-",
	"stop-",
	"start-",
	"reboot-",
	"revoke-",
	"disable-",
	"deregister-",
	"attach-",
	"detach-",
	"run-",
	"schedule-",
];

function classifyCloud(name: string, args: string[]): ShellClassification | undefined {
	const words = args.filter((arg) => !arg.startsWith("-"));
	const mutatingPrefixes = [
		"create",
		"delete",
		"update",
		"modify",
		"put",
		"remove",
		"terminate",
		"stop",
		"start",
		"reboot",
		"deploy",
		"destroy",
		"set",
	];

	if (name === "gcloud") {
		const gpath = gcloudCommandPath(args);
		if (gpath[0] === "auth" && gpath[1] !== "list") {
			return { level: "forbidden", reason: "gcloud auth mutation (non-list) is blocked" };
		}
		if (gpath[0] === "auth" && gpath[1] === "list") {
			return { level: "readonly", reason: "read-only gcloud auth list" };
		}
	}

	if (name === "aws") {
		if (words[0] === "s3" && ["cp", "mv", "rm", "rb", "sync", "mb"].includes(words[1] ?? "")) {
			return { level: "forbidden", reason: "aws s3 mutating operation is blocked" };
		}
		// Mag matches the action token (`path[1]`, the service subcommand) with
		// startsWithAny(action, AWS_MUTATING_PREFIXES). In mag, path[0] is the
		// command base ("aws") and path[1] is the SERVICE (e.g. "ec2"). piki's
		// `words` already excludes the command base, so the service is words[0].
		// This aligns piki to mag and removes piki's prior over-block of verbs
		// such as `aws deploy create-application` (last-word match against shared
		// prefixes would have matched the verb "create-application").
		const awsAction = words[0] ?? "";
		if (AWS_MUTATING_PREFIXES.some((prefix) => awsAction.startsWith(prefix))) {
			return { level: "forbidden", reason: `aws ${awsAction} can mutate cloud resources` };
		}
		return { level: "normal", reason: "aws command requires normal shell permission" };
	}

	if (name === "gcloud" || name === "az") {
		if (words.some((word) => mutatingPrefixes.some((prefix) => word === prefix || word.startsWith(`${prefix}-`)))) {
			return { level: "forbidden", reason: `${name} command can mutate cloud resources` };
		}
		return { level: "normal", reason: `${name} command requires normal shell permission` };
	}

	return undefined;
}

function classifyIac(name: string, args: string[]): ShellClassification | undefined {
	if (name !== "terraform" && name !== "terragrunt" && name !== "pulumi" && name !== "sst" && name !== "cdk") {
		return undefined;
	}
	const subcommand = args.find((arg) => !arg.startsWith("-"));
	if (!subcommand) return { level: "normal", reason: `${name} command without read-only subcommand` };
	const nestedSubcommand = (sub: string, verbs: Set<string>): boolean => {
		const idx = args.indexOf(sub);
		return idx !== -1 && args.slice(idx + 1).some((a) => verbs.has(a));
	};
	if (
		(name === "terraform" || name === "terragrunt") &&
		(TERRAFORM_FORBIDDEN.has(subcommand) ||
			(subcommand === "state" && args.some((arg) => ["rm", "mv", "push", "replace-provider"].includes(arg))) ||
			nestedSubcommand("workspace", new Set(["new", "delete", "select"])))
	) {
		return { level: "forbidden", reason: `${name} ${subcommand} can mutate infrastructure state` };
	}
	if (
		name === "pulumi" &&
		(["up", "destroy", "cancel"].includes(subcommand) || nestedSubcommand("stack", new Set(["rm", "init", "import"])))
	) {
		return { level: "forbidden", reason: `pulumi ${subcommand} can mutate infrastructure` };
	}
	if (name === "sst" && ["deploy", "dev", "remove"].includes(subcommand)) {
		return { level: "forbidden", reason: `sst ${subcommand} can mutate infrastructure` };
	}
	if (name === "cdk" && ["deploy", "destroy"].includes(subcommand)) {
		return { level: "forbidden", reason: `cdk ${subcommand} can mutate infrastructure` };
	}
	return { level: "normal", reason: `${name} command requires normal shell permission` };
}

/** Helm mutating subcommands (alpha22 `isHelmForbidden` parity). */
const HELM_FORBIDDEN = new Set(["install", "upgrade", "uninstall", "rollback", "test"]);

function classifyHelm(args: string[]): ShellClassification | undefined {
	const subcommand = findSubcommandAfterFlags(args);
	if (!subcommand) return { level: "normal", reason: "helm command without read-only subcommand" };
	const subcommand2 = args.find((arg, index) => index > args.indexOf(subcommand) && !arg.startsWith("-"));
	if (HELM_FORBIDDEN.has(subcommand)) {
		return { level: "forbidden", reason: `helm ${subcommand} can mutate cluster/repository state` };
	}
	if (subcommand === "push") {
		return { level: "forbidden", reason: "helm push can mutate registry artifacts" };
	}
	if (subcommand === "registry" && (subcommand2 === "login" || subcommand2 === "logout")) {
		return { level: "forbidden", reason: "helm registry login/logout mutates registry auth" };
	}
	if (subcommand === "repo" && (subcommand2 === "add" || subcommand2 === "remove" || subcommand2 === "update")) {
		return { level: "forbidden", reason: "helm repo add/remove/update mutates repository configuration" };
	}
	if (
		subcommand === "plugin" &&
		(subcommand2 === "install" || subcommand2 === "uninstall" || subcommand2 === "update")
	) {
		return { level: "forbidden", reason: "helm plugin install/uninstall/update mutates local plugin state" };
	}
	if (includesAnyArg(args, ["--force"])) {
		return { level: "forbidden", reason: "helm --force can recreate resources disruptively" };
	}
	return { level: "normal", reason: "helm command requires normal shell permission" };
}

/**
 * Database-utility commands that read or write database state (alpha22
 * `DB_UTILITY_COMMANDS`). Blocked as forbidden to match alpha22's default-deny
 * for these tools.
 */
const DB_UTILITY_COMMANDS = new Set([
	"pg_dump",
	"pg_restore",
	"mysqldump",
	"createdb",
	"dropdb",
	"createuser",
	"dropuser",
]);

function classifyDbUtility(name: string, segment: ShellCommandSegment): ShellClassification | undefined {
	if (!DB_UTILITY_COMMANDS.has(name)) return undefined;
	// `psql -c "SELECT 1"` style read-only queries are permitted; anything
	// against a DB shell is otherwise treated as forbidden (alpha22 blocks the
	// shell entirely). We only block the dedicated dump/restore/admin utilities
	// and the interactive shells, leaving fine-grained SQL analysis to the
	// DB_SHELLS classification.
	if (name === "psql" || name === "mysql" || name === "mariadb" || name === "sqlite3") return undefined;
	return { level: "forbidden", reason: `${name} database utility is blocked`, command: segment };
}

/**
 * System-service / power / partition / firewall classification (alpha22
 * `getSysadminAlwaysForbiddenReason` + `systemServiceForbidden` parity).
 */
function forbidReasonForSysadminAlways(base: string): string {
	const b = base.toLowerCase();
	if (["shutdown", "reboot", "poweroff", "halt"].includes(b)) {
		return "Host power-control commands can immediately terminate the working environment";
	}
	if (["fdisk", "parted"].includes(b)) {
		return "Partition edits can irreversibly alter disks and destroy data";
	}
	if (["iptables", "nft", "ufw", "firewall-cmd"].includes(b)) {
		return "Firewall mutations can break connectivity and unrelated services";
	}
	return "High-impact system administration command is blocked";
}

function classifySystemService(base: string, args: string[]): ShellClassification | undefined {
	const positionals = args.filter((arg) => !arg.startsWith("-"));
	const alwaysForbidden = new Set(["poweroff", "reboot", "halt", "rescue", "emergency", "default"]);
	const criticalActions = new Set(["stop", "disable", "mask"]);
	const criticalTargets = new Set(["network", "networkmanager", "sshd", "docker"]);
	const normalizeTarget = (token: string | undefined) =>
		token?.endsWith(".service") ? token.slice(0, -".service".length) : token;
	if (base === "systemctl") {
		const action = positionals[0];
		const target = normalizeTarget(positionals[1]);
		if (action && alwaysForbidden.has(action)) {
			return {
				level: "forbidden",
				reason: `systemctl ${action} can destabilize system runtime`,
				command: undefined,
			};
		}
		if (action && criticalActions.has(action) && target && criticalTargets.has(target)) {
			return {
				level: "forbidden",
				reason: `Stopping or disabling ${target} can cut access or break platform dependencies`,
				command: undefined,
			};
		}
		return undefined;
	}
	const actionFirst = positionals[0];
	const actionSecond = positionals[1];
	const targetFirst = normalizeTarget(positionals[0]);
	const targetSecond = normalizeTarget(positionals[1]);
	if (actionFirst && alwaysForbidden.has(actionFirst)) {
		return {
			level: "forbidden",
			reason: `service ${actionFirst} can destabilize system runtime`,
			command: undefined,
		};
	}
	if (actionSecond && alwaysForbidden.has(actionSecond)) {
		return {
			level: "forbidden",
			reason: `service ${actionSecond} can destabilize system runtime`,
			command: undefined,
		};
	}
	if (actionSecond && criticalActions.has(actionSecond) && targetFirst && criticalTargets.has(targetFirst)) {
		return {
			level: "forbidden",
			reason: `Stopping or disabling ${targetFirst} can cut access or break platform dependencies`,
			command: undefined,
		};
	}
	if (actionFirst && criticalActions.has(actionFirst) && targetSecond && criticalTargets.has(targetSecond)) {
		return {
			level: "forbidden",
			reason: `Stopping or disabling ${targetSecond} can cut access or break platform dependencies`,
			command: undefined,
		};
	}
	return undefined;
}

function classifyMountUmount(name: string, args: string[]): ShellClassification | undefined {
	if (name !== "mount" && name !== "umount") return undefined;
	// piki keeps mag's stricter critical-path block; mount on core paths only.
	const criticalPaths = ["/", "/system", "/usr", "/etc", "/var"];
	const lower = args.map((a) => a.toLowerCase());
	for (const token of lower) {
		if (token.startsWith("-")) continue;
		if (criticalPaths.includes(token) || criticalPaths.some((p) => token.startsWith(`${p}/`))) {
			return {
				level: "forbidden",
				reason: "Mount changes on core paths can break OS/tooling immediately",
				command: undefined,
			};
		}
	}
	return undefined;
}

/** `kill -9 1` (PID 1) style system-init kills (alpha22 `killForbidden`). */
function classifyKill(args: string[]): ShellClassification | undefined {
	let expectSignalValue = false;
	let afterDoubleDash = false;
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (afterDoubleDash) {
			if (token === "1" || token === "-1") {
				return { level: "forbidden", reason: "Killing PID 1 can crash the entire environment", command: undefined };
			}
			continue;
		}
		if (token === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (expectSignalValue) {
			expectSignalValue = false;
			continue;
		}
		if (token === "-s" || token === "--signal") {
			expectSignalValue = true;
			continue;
		}
		if (token === "-1") {
			return { level: "forbidden", reason: "Killing PID 1 can crash the entire environment", command: undefined };
		}
		if (!token.startsWith("-") && token === "1") {
			return { level: "forbidden", reason: "Killing PID 1 can crash the entire environment", command: undefined };
		}
	}
	return undefined;
}

/** `pkill -9 <broad-name>` style hard-kill of broad process classes. */
function classifyPkillKillall(args: string[]): ShellClassification | undefined {
	const hasHardKill =
		args.some((a) => a === "-9" || a === "-kill" || a === "-sigkill") ||
		args.some((a) => a === "--signal=9" || a === "--signal=kill" || a === "--signal=sigkill") ||
		args.some(
			(a, i) =>
				(a === "--signal" || a === "-s") &&
				(args[i + 1] === "9" || args[i + 1] === "kill" || args[i + 1] === "sigkill"),
		);
	if (!hasHardKill) return undefined;
	for (const token of args) {
		if (token.startsWith("-")) continue;
		if (PKILL_BROAD_NAMES.has(token)) {
			return {
				level: "forbidden",
				reason: "Pattern-based hard kills can terminate many unrelated processes",
				command: undefined,
			};
		}
	}
	return undefined;
}

/** OS package-manager destructive subcommands (alpha22 `isPackageManagerForbidden`). */
function classifyOsPackageManager(base: string, args: string[]): ShellClassification | undefined {
	const b = base.toLowerCase();
	const positionals = args.filter((arg) => !arg.startsWith("-")).map((a) => a.toLowerCase());
	if (b === "brew") {
		if (positionals[0] === "services") {
			const sub = positionals[1];
			if (sub === "stop") {
				return {
					level: "forbidden",
					reason: "Stopping brew services can disrupt active dependencies",
					command: undefined,
				};
			}
			if (sub === "cleanup") {
				return {
					level: "forbidden",
					reason: "brew services cleanup can alter runtime behavior",
					command: undefined,
				};
			}
		}
		if (positionals[0] === "cleanup") {
			return { level: "forbidden", reason: "brew cleanup can alter runtime behavior", command: undefined };
		}
	}
	for (const token of positionals) {
		if (PACKAGE_DESTRUCTIVE_TOKENS.has(token)) {
			return {
				level: "forbidden",
				reason: "Destructive package operation can remove required tooling",
				command: undefined,
			};
		}
	}
	return undefined;
}

const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "ash", "busybox"]);

function classifySegment(segment: ShellCommandSegment): ShellClassification {
	const name = basename(segment.name);
	const args = segment.args;

	if (name === ":") {
		return {
			level: "forbidden",
			reason: "This command is blocked as a shell-control sentinel, not a useful task action.",
		};
	}
	// Raw device copy/write can irreversibly destroy disks. Mirrors mag's
	// `isForbidden` (magnitude-alpha22.embedded.js:80569): a plain `dd` is allowed,
	// but `dd if=<src>` or `dd of=/dev<dst>` is forbidden.
	if (name === "dd" && args.some((a) => a.startsWith("if=") || a.startsWith("of=/dev"))) {
		return {
			level: "forbidden",
			reason:
				"Raw device copy/write can destroy entire disks quickly. Use file-level copy commands on workspace files only.",
			command: segment,
		};
	}
	if (name === "sudo" && args.length > 0) {
		const nested = args.filter((arg) => !arg.startsWith("-")).join(" ");
		const nestedResult = classifyShellCommand(nested);
		return { ...nestedResult, reason: `sudo wraps ${nestedResult.reason}`, command: segment };
	}
	if (SHELL_INTERPRETERS.has(name)) {
		const commandFlagIndex = args.findIndex((arg) => arg === "-c" || arg.endsWith("c"));
		const nested = commandFlagIndex === -1 ? undefined : args[commandFlagIndex + 1];
		if (nested) {
			const nestedResult = classifyShellCommand(nested.replace(/^["']|["']$/g, ""));
			return { ...nestedResult, reason: `${name} -c wraps ${nestedResult.reason}`, command: segment };
		}
	}
	// Guard against recursive rm of root/home with any flag variant:
	// -rf, -fr, -Rf, -fR, -r, -R, --recursive, plus -f or --force
	const rmRecursive = args.some(
		(a) =>
			a === "-rf" ||
			a === "-fr" ||
			a === "-r" ||
			a === "-R" ||
			a === "--recursive" ||
			// Combined flags: any arg starting with - that contains both r/R and f
			(/^-/.test(a) && /[rR]/.test(a) && /f/.test(a)),
	);
	// Force-deleting system paths is forbidden regardless of protected roots,
	// matching mag's exact `hasForce` (`-rf`/`-fr`/`-f`) and target predicate.
	const SYSTEM_DIRS = new Set([
		"/etc",
		"/usr",
		"/System",
		"/bin",
		"/sbin",
		"/boot",
		"/var",
		"/lib",
		"/dev",
		"/proc",
		"/sys",
	]);
	const targetsSystemDir = (arg: string): boolean => {
		if (arg.startsWith("-")) return false;
		return arg === "/" || SYSTEM_DIRS.has(arg) || [...SYSTEM_DIRS].some((d) => arg.startsWith(`${d}/`));
	};
	const rmHasForce = args.some((a) => a === "-rf" || a === "-fr" || a === "-f");
	if (name === "rm" && rmHasForce && args.some((a) => targetsSystemDir(a))) {
		return { level: "forbidden", reason: "Force-deleting system paths is blocked", command: segment };
	}
	if (name === "rm" && rmRecursive && (args.includes("/") || args.includes("~") || args.includes("/root"))) {
		return { level: "forbidden", reason: "recursive removal of root or home is blocked", command: segment };
	}
	if (name === "rm" && rmRecursive) {
		return { level: "mass-destructive", reason: "recursive removal can delete many files", command: segment };
	}
	if (
		name === "rsync" &&
		args.some(
			(a) =>
				a === "--delete" ||
				a === "--delete-before" ||
				a === "--delete-during" ||
				a === "--delete-delay" ||
				a === "--delete-after",
		)
	) {
		return { level: "mass-destructive", reason: "rsync --delete can remove many files", command: segment };
	}
	// Block `find` with mutating actions: -delete, -exec rm, -execdir rm.
	// Mirrors Magnitude alpha22's `isFindMassDestructive`: only -exec/-execdir
	// (not -ok/-okdir) whose executed command basename === "rm" is blocked, and
	// mag does NOT special-case the `+` batch form.
	if (name === "find") {
		if (args.includes("-delete")) {
			return { level: "forbidden", reason: "find -delete can mutate the filesystem", command: segment };
		}
		const FIND_EXEC_ACTIONS = ["-exec", "-execdir"];
		for (const action of FIND_EXEC_ACTIONS) {
			const actionIndex = args.indexOf(action);
			if (actionIndex !== -1) {
				const execCmd = args[actionIndex + 1];
				if (execCmd && !execCmd.startsWith("-") && !execCmd.startsWith("{") && !execCmd.startsWith(";")) {
					const execBase = basename(execCmd);
					if (execBase === "rm") {
						return {
							level: "forbidden",
							reason: `find ${action} with destructive command "rm" is blocked`,
							command: segment,
						};
					}
				}
			}
		}
	}
	if (name === "git") return { ...classifyGit(args)!, command: segment };
	if (LANG_PACKAGE_MANAGERS.has(name.toLowerCase()) && isLangPackageManagerForbidden(name, args)) {
		return { level: "forbidden", reason: `${name} package-manager mutation is blocked`, command: segment };
	}
	if (name === "helm") return { ...classifyHelm(args)!, command: segment };
	if (name === "kubectl") return { ...classifyKubectl(args)!, command: segment };
	if (DB_SHELLS.has(name))
		return { level: "forbidden", reason: `${name} database shell is blocked`, command: segment };
	const dbUtility = classifyDbUtility(name, segment);
	if (dbUtility) return dbUtility;
	// sysadmin power / partition / firewall always-forbidden (mag
	// SYSADMIN_ALWAYS_FORBIDDEN / POWER / PARTITION / FIREWALL command sets).
	if (SYSADMIN_ALWAYS_FORBIDDEN.has(name)) {
		return { level: "forbidden", reason: forbidReasonForSysadminAlways(name), command: segment };
	}
	// systemctl / service: nuanced rescue/power subcases + critical-service stop.
	const serviceResult = classifySystemService(name, args);
	if (serviceResult) return { ...serviceResult, command: segment };
	// kill PID 1 / pkill-killall broad-name hard kills (mag killForbidden /
	// pkillKillallForbidden).
	if (name === "kill") {
		const killResult = classifyKill(args);
		if (killResult) return { ...killResult, command: segment };
	}
	if (name === "pkill" || name === "killall") {
		const pkResult = classifyPkillKillall(args);
		if (pkResult) return { ...pkResult, command: segment };
	}
	// mount / umount on critical paths (piki keeps mag's stricter block).
	const mountResult = classifyMountUmount(name, args);
	if (mountResult) return { ...mountResult, command: segment };
	// OS package managers (apt/yum/pacman/snap/brew) destructive subcommands.
	if (PACKAGE_MANAGERS.has(name)) {
		const pmResult = classifyOsPackageManager(name, args);
		if (pmResult) return { ...pmResult, command: segment };
	}

	const container = classifyContainer(name, args);
	if (container) return { ...container, command: segment };
	const cloud = classifyCloud(name, args);
	if (cloud) return { ...cloud, command: segment };
	const iac = classifyIac(name, args);
	if (iac) return { ...iac, command: segment };

	if (READONLY_COMMANDS.has(name)) return { level: "readonly", reason: "read-only shell command", command: segment };
	return { level: "normal", reason: "command requires normal shell permission", command: segment };
}

export function classifyShellCommand(command: string): ShellClassification {
	for (const nested of extractCommandSubstitutions(command)) {
		const nestedResult = classifyShellCommand(nested);
		if (nestedResult.level === "forbidden") return nestedResult;
	}

	const segments = parseShellCommand(command);
	if (segments.length === 0) return { level: "readonly", reason: "empty command" };

	let sawMassDestructive: ShellClassification | undefined;
	let sawNormal: ShellClassification | undefined;
	for (const segment of segments) {
		const result = classifySegment(segment);
		if (result.level === "forbidden") return result;
		if (result.level === "mass-destructive" && !sawMassDestructive) sawMassDestructive = result;
		if (result.level === "normal" && !sawNormal) sawNormal = result;
	}

	return (
		sawMassDestructive ??
		sawNormal ?? { level: "readonly", reason: "all command segments are read-only", command: segments[0] }
	);
}
