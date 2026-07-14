/**
 * Shell command safety classifier.
 *
 * Parses common shell command structure so destructive commands are detected
 * across pipelines, separators, and command substitutions.
 */

export type ShellSafetyLevel = "readonly" | "normal" | "mass-destructive" | "forbidden";

export interface ShellCommandSegment {
	name: string;
	args: string[];
	separatorBefore?: string;
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
const DB_SHELLS = new Set([
	"mysql",
	"mariadb",
	"psql",
	"mongosh",
	"redis-cli",
	"redis",
	"sqlite3",
	"clickhouse-client",
]);
const SYSADMIN_FORBIDDEN = new Set([
	"systemctl",
	"service",
	"mount",
	"umount",
	"fdisk",
	"mkfs",
	"iptables",
	"nft",
	"ufw",
	"firewall-cmd",
	"useradd",
	"userdel",
	"usermod",
	"groupadd",
	"groupdel",
	"chown",
	"chmod",
	"chroot",
]);
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

	for (const token of tokens) {
		if (token === "|" || token === "&&" || token === "||" || token === ";") {
			if (current.length > 0) {
				segments.push({ name: basename(current[0]!), args: current.slice(1), separatorBefore });
				current = [];
			}
			separatorBefore = token;
			continue;
		}
		if (token.includes("=") && current.length === 0 && !token.startsWith("-")) {
			continue;
		}
		current.push(token);
	}

	if (current.length > 0) {
		segments.push({ name: basename(current[0]!), args: current.slice(1), separatorBefore });
	}

	return segments;
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

function classifyGit(args: string[]): ShellClassification | undefined {
	if (
		args.includes("-c") ||
		args.some((arg) => GIT_UNSAFE_FLAGS.has(arg) || (arg.includes("=") && GIT_UNSAFE_FLAGS.has(arg.split("=")[0]!)))
	) {
		return { level: "forbidden", reason: "git command uses config or execution-affecting flags" };
	}
	const subcommand = args.find((arg) => !arg.startsWith("-"));
	if (!subcommand) return { level: "normal", reason: "git command without read-only subcommand" };
	if (GIT_READONLY.has(subcommand)) return { level: "readonly", reason: "read-only git command" };
	if (subcommand === "branch" && args.every((arg) => arg === "branch" || arg.startsWith("-"))) {
		return { level: "readonly", reason: "read-only git branch command" };
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

function classifyContainer(name: string, args: string[]): ShellClassification | undefined {
	if (name !== "docker" && name !== "podman") return undefined;
	if (args.some((arg) => ["login", "logout", "push"].includes(arg))) {
		return { level: "forbidden", reason: `${name} remote credential or push operation is blocked` };
	}
	if (args.includes("prune")) return { level: "forbidden", reason: `${name} prune can remove many resources` };
	if (includesAnyArg(args, ["--privileged", "--pid=host", "--ipc=host", "--uts=host", "--network=host"])) {
		return { level: "forbidden", reason: `${name} command requests privileged or host namespace access` };
	}
	if (args.some((arg) => arg.toLowerCase() === "--cap-add=all" || arg.toLowerCase() === "--cap-add=sys_admin")) {
		return { level: "forbidden", reason: `${name} command adds dangerous Linux capabilities` };
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
	if (includesAnyArg(args, ["--force", "--grace-period=0", "--all", "-A", "--all-namespaces"])) {
		return { level: "forbidden", reason: "kubectl command broadens blast radius or forces changes" };
	}
	if (subcommand === "rollout" && args.some((arg) => ["restart", "undo", "pause", "resume"].includes(arg))) {
		return { level: "forbidden", reason: "kubectl rollout operation mutates workloads" };
	}
	return ["get", "describe", "logs", "top", "version"].includes(subcommand)
		? { level: "readonly", reason: "read-only kubectl command" }
		: { level: "normal", reason: "kubectl command requires normal shell permission" };
}

function classifyCloud(name: string, args: string[]): ShellClassification | undefined {
	const words = args.filter((arg) => !arg.startsWith("-"));
	const operation = words[words.length - 1] ?? "";
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

	if (name === "aws") {
		if (words[0] === "s3" && ["cp", "mv", "rm", "rb", "sync", "mb"].includes(words[1] ?? "")) {
			return { level: "forbidden", reason: "aws s3 mutating operation is blocked" };
		}
		if (mutatingPrefixes.some((prefix) => operation.startsWith(`${prefix}-`) || operation === prefix)) {
			return { level: "forbidden", reason: `aws ${operation} can mutate cloud resources` };
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
	if (
		(name === "terraform" || name === "terragrunt") &&
		(TERRAFORM_FORBIDDEN.has(subcommand) ||
			(subcommand === "state" && args.some((arg) => ["rm", "mv", "push", "replace-provider"].includes(arg))))
	) {
		return { level: "forbidden", reason: `${name} ${subcommand} can mutate infrastructure state` };
	}
	if (name === "pulumi" && ["up", "destroy", "cancel"].includes(subcommand)) {
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

const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "ash", "busybox"]);

function classifySegment(segment: ShellCommandSegment): ShellClassification {
	const name = basename(segment.name);
	const args = segment.args;

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
	if (name === "rm" && rmRecursive && (args.includes("/") || args.includes("~") || args.includes("/root"))) {
		return { level: "forbidden", reason: "recursive removal of root or home is blocked", command: segment };
	}
	if (name === "rm" && rmRecursive) {
		return { level: "mass-destructive", reason: "recursive removal can delete many files", command: segment };
	}
	if (name === "chmod" && args.includes("-R") && args.includes("777")) {
		return { level: "forbidden", reason: "recursive chmod 777 is blocked", command: segment };
	}
	// Block `find` with mutating actions: -delete, -exec rm, -execdir rm, etc.
	if (name === "find") {
		const DANGEROUS_EXEC_COMMANDS = new Set(["rm", "rmdir", "shred", "mkfs", "dd", "truncate", "chmod", "chown"]);
		const MUTATING_ACTIONS = ["-exec", "-execdir", "-ok", "-okdir"];
		if (args.includes("-delete")) {
			return { level: "forbidden", reason: "find -delete can mutate the filesystem", command: segment };
		}
		for (const action of MUTATING_ACTIONS) {
			const actionIndex = args.indexOf(action);
			if (actionIndex !== -1) {
				// The next arg after the action is the command to execute.
				const execCmd = args[actionIndex + 1];
				if (execCmd && !execCmd.startsWith("-") && !execCmd.startsWith("{") && !execCmd.startsWith(";")) {
					const execBase = basename(execCmd);
					if (DANGEROUS_EXEC_COMMANDS.has(execBase)) {
						return {
							level: "forbidden",
							reason: `find ${action} with destructive command "${execBase}" is blocked`,
							command: segment,
						};
					}
				}
				// Block any -exec that ends with + (batch mode) since it can have
				// elevated blast radius with destructive commands.
				if (args.includes("+") && args.indexOf("+") > actionIndex) {
					const execCmdBatch = args[actionIndex + 1];
					if (execCmdBatch && DANGEROUS_EXEC_COMMANDS.has(basename(execCmdBatch ?? ""))) {
						return {
							level: "forbidden",
							reason: `find ${action} with batched destructive command is blocked`,
							command: segment,
						};
					}
				}
			}
		}
	}
	if (name === "git") return { ...classifyGit(args)!, command: segment };
	if (name === "kubectl") return { ...classifyKubectl(args)!, command: segment };
	if (DB_SHELLS.has(name))
		return { level: "forbidden", reason: `${name} database shell is blocked`, command: segment };
	if (SYSADMIN_FORBIDDEN.has(name)) {
		return { level: "forbidden", reason: `${name} is a sysadmin-level command and is blocked`, command: segment };
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
