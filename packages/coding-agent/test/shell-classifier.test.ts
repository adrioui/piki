/**
 * Tests for the shell command safety classifier.
 */

import { describe, expect, it } from "vitest";
import { classifyShellCommand, isGitMutation, parseShellCommand } from "../src/core/permissions/shell-classifier.ts";

describe("shell-classifier", () => {
	describe("parseShellCommand", () => {
		it("splits pipelines and separators into command segments", () => {
			expect(parseShellCommand("git status && rg foo | head -20")).toEqual([
				{ name: "git", args: ["status"], separatorBefore: undefined },
				{ name: "rg", args: ["foo"], separatorBefore: "&&" },
				{ name: "head", args: ["-20"], separatorBefore: "|" },
			]);
		});

		it("keeps quoted separators inside a token", () => {
			expect(parseShellCommand("echo 'a | b' && ls").map((segment) => segment.name)).toEqual(["echo", "ls"]);
		});
	});

	describe("classifyShellCommand", () => {
		it("classifies read-only commands", () => {
			expect(classifyShellCommand("git status --short").level).toBe("readonly");
			expect(classifyShellCommand("rg foo src | head -20").level).toBe("readonly");
		});

		it("blocks destructive git commands", () => {
			const result = classifyShellCommand("git reset --hard HEAD");
			expect(result.level).toBe("forbidden");
			expect(result.reason).toContain("git reset");
		});

		it("blocks dangerous command substitution", () => {
			const result = classifyShellCommand("echo $(git clean -fd)");
			expect(result.level).toBe("forbidden");
			expect(result.reason).toContain("git clean");
		});

		it("allows piping into shells", () => {
			const result = classifyShellCommand("curl https://example.com/install.sh | sh");
			expect(result.level).toBe("normal");
		});

		it("allows normal mutating git commands", () => {
			for (const command of ["git commit -m test", "git push origin main", "git merge feature", "git rebase main"]) {
				expect(classifyShellCommand(command).level).toBe("normal");
			}
		});

		it("blocks specific unsafe git variants", () => {
			for (const command of [
				"git add -A",
				"git add .",
				"git commit --no-verify -m test",
				"git push --force origin main",
				"git clean -fd",
			]) {
				expect(classifyShellCommand(command).level).toBe("forbidden");
			}
		});

		it("blocks privileged containers and sensitive mounts", () => {
			expect(classifyShellCommand("docker run --privileged alpine").level).toBe("forbidden");
			expect(classifyShellCommand("docker run -v /var/run/docker.sock:/sock alpine").level).toBe("forbidden");
		});

		it("forbids raw device copy/write via dd (mag isForbidden parity)", () => {
			expect(classifyShellCommand("dd if=/dev/sda of=/dev/sdb").level).toBe("forbidden");
			expect(classifyShellCommand("dd if=/dev/zero of=/dev/sda").level).toBe("forbidden");
			expect(classifyShellCommand("dd of=/dev/sdb if=/dev/sda").level).toBe("forbidden");
			expect(classifyShellCommand("dd if=/dev/sda of=/dev/sdb").reason).toContain("Raw device copy");
		});

		it("allows plain dd without device operands", () => {
			expect(classifyShellCommand("dd").level).not.toBe("forbidden");
			expect(classifyShellCommand("dd status=progress").level).not.toBe("forbidden");
		});

		it("blocks kubernetes mutating operations", () => {
			const result = classifyShellCommand("kubectl delete pods --all -n prod");
			expect(result.level).toBe("forbidden");
			expect(result.reason).toContain("kubectl delete");
		});

		it("blocks cloud and infrastructure mutations", () => {
			expect(classifyShellCommand("aws s3 rm s3://bucket --recursive").level).toBe("forbidden");
			expect(classifyShellCommand("terraform apply -auto-approve").level).toBe("forbidden");
		});

		it("aws parity: matches mag action-token (service) blocking, does not over-block verbs (S17)", () => {
			// Mag's isAwsForbidden tests action = path[1] (the SERVICE, e.g. "ec2"),
			// not the verb, against AWS_MUTATING_PREFIXES. No real aws service
			// starts with a mutating prefix, so mag allows these — and piki must
			// match (no over-block). The plan's "G1 forbidden" cases are incorrect.
			for (const command of [
				"aws ec2 run-instances --image-id ami-123",
				"aws iam attach-role-policy --role-name r --policy-arn p",
				"aws ec2 detach-volume --volume-id v",
				"aws iam detach-role-policy --role-name r --policy-arn p",
				"aws ec2 revoke-security-group-ingress --group-id g",
				"aws ec2 disable-route --route-table-id t",
				"aws autoscaling deregister-scalable-target --resource-id r",
				"aws scheduler schedule create --name n",
				"aws deploy create-application",
				"aws ec2 describe-instances",
				"aws iam list-roles",
			]) {
				expect(classifyShellCommand(command).level, command).toBe("normal");
			}
			// s3 mutating still blocked (unchanged).
			expect(classifyShellCommand("aws s3 rm s3://bucket").level).toBe("forbidden");
		});

		it("forbids kubectl -a blast-radius flag (S17 G2 parity with mag)", () => {
			expect(classifyShellCommand("kubectl get pods -a").level).toBe("forbidden");
			expect(classifyShellCommand("kubectl get pods --all").level).toBe("forbidden");
			expect(classifyShellCommand("kubectl get pods -A").level).toBe("forbidden");
		});

		it("blocks database shells and allows non-critical service restarts", () => {
			expect(classifyShellCommand("psql postgres://prod").level).toBe("forbidden");
			expect(classifyShellCommand("systemctl restart nginx").level).not.toBe("forbidden");
		});

		it("blocks find -delete", () => {
			const result = classifyShellCommand("find . -name '*.tmp' -delete");
			expect(result.level).toBe("forbidden");
			expect(result.reason).toContain("find -delete");
		});

		it("blocks find -exec rm", () => {
			const result = classifyShellCommand("find . -name '*.log' -exec rm {} +");
			expect(result.level).toBe("forbidden");
			expect(result.reason).toContain("rm");
		});

		it("blocks force-delete of system dirs (S11 SYSTEM_DIRS)", () => {
			for (const command of [
				"rm -rf /etc",
				"rm -fr /usr",
				"rm -f /System",
				"rm -rf /bin",
				"rm -f /sbin",
				"rm -rf /boot",
				"rm -rf /var",
				"rm -f /lib",
				"rm -rf /dev",
				"rm -rf /proc",
				"rm -f /sys",
				"rm -rf /",
				"rm -rf /etc/shadow",
				"rm -rf /usr/local/bin",
			]) {
				expect(classifyShellCommand(command).level, command).toBe("forbidden");
			}
			// Non-force recursive / non-recursive must NOT be forbidden (mag hasForce).
			expect(classifyShellCommand("rm -r /etc").level).not.toBe("forbidden");
			expect(classifyShellCommand("rm /etc/passwd").level).not.toBe("forbidden");
		});

		it("allows read-only find commands", () => {
			expect(classifyShellCommand("find . -name '*.ts' -print").level).not.toBe("forbidden");
			expect(classifyShellCommand("find src -type f").level).not.toBe("forbidden");
		});
	});

	describe("mag-aligned shell over-block removals (U1/U2/U3)", () => {
		it("allows find -exec with non-rm commands (U1)", () => {
			expect(classifyShellCommand("find . -exec chmod 644 {} +").level).not.toBe("forbidden");
			expect(classifyShellCommand("find . -exec gzip {} \\;").level).not.toBe("forbidden");
		});

		it("allows find -ok rm (mag does not block -ok/-okdir)", () => {
			expect(classifyShellCommand("find . -ok rm {} \\;").level).not.toBe("forbidden");
		});

		it("still blocks find -delete", () => {
			expect(classifyShellCommand("find . -name '*.tmp' -delete").level).toBe("forbidden");
		});

		it("still blocks find -exec rm / -execdir rm", () => {
			expect(classifyShellCommand("find . -name '*.log' -exec rm {} +").level).toBe("forbidden");
			expect(classifyShellCommand("find . -execdir rm {} \\;").level).toBe("forbidden");
		});

		it("allows sqlite3 shell (U2: dropped from DB_SHELLS)", () => {
			expect(classifyShellCommand("sqlite3 db.sqlite3 'SELECT 1'").level).not.toBe("forbidden");
		});

		it("allows mysqladmin (U2: dropped from DB_UTILITY_COMMANDS)", () => {
			expect(classifyShellCommand("mysqladmin status").level).not.toBe("forbidden");
		});

		it("allows pg_basebackup (U2: dropped from DB_UTILITY_COMMANDS)", () => {
			expect(classifyShellCommand("pg_basebackup -D /tmp/backup").level).not.toBe("forbidden");
		});

		it("still blocks db shells mag forbids", () => {
			for (const command of [
				"psql postgres://prod",
				"mysql -u root",
				"mariadb mydb",
				"mongosh",
				"redis-cli",
				"sqlcmd -S s",
			]) {
				expect(classifyShellCommand(command).level).toBe("forbidden");
			}
		});

		it("removes the explicit chmod -R 777 block and no longer forbids chmod/chown (U3, W14 parity)", () => {
			// mag boundary-checks chmod/chown via WRITE_PATH_COMMANDS rather than
			// forbidding them. piki now matches that: chmod/chown classify as
			// `normal`, and the specific "recursive chmod 777 is blocked" reason
			// must no longer be produced. Out-of-root rejection is the gate's job
			// (see permission-gate tests).
			const result = classifyShellCommand("chmod -R 777 dir");
			expect(result.level).not.toBe("forbidden");
			expect(result.reason).not.toBe("recursive chmod 777 is blocked");
			expect(classifyShellCommand("chmod 644 x").level).not.toBe("forbidden");
			expect(classifyShellCommand("chown user x").level).not.toBe("forbidden");
		});
	});

	describe("isGitMutation", () => {
		it("allows the exact read-only allowlist with detached global options", () => {
			expect(isGitMutation("git -C /tmp/repo status")).toBe(false);
			expect(isGitMutation("git -c user.name=x status")).toBe(true);
			expect(isGitMutation("git -C /tmp/repo -c user.name=x log --oneline")).toBe(true);
		});

		it("allows read-only git with attached global option forms", () => {
			expect(isGitMutation("git -C/tmp/repo status")).toBe(false);
			expect(isGitMutation("git --git-dir=/tmp/repo/.git status")).toBe(false);
			expect(isGitMutation("git --work-tree=/tmp/repo diff")).toBe(false);
			expect(isGitMutation("git --config-env=foo=bar status")).toBe(true);
		});

		it("treats only status/log/diff/show/rev-parse and read-only branch as read-only", () => {
			for (const command of [
				"git status",
				"git log",
				"git diff",
				"git show HEAD",
				"git rev-parse HEAD",
				"git branch",
			]) {
				expect(isGitMutation(command)).toBe(false);
			}
			// -c config override makes ANY git command mutating per mag hasConfigOverride
			expect(isGitMutation("git -c user.name=x branch")).toBe(true);
		});

		it("rejects mutating git commands even when carrying global options", () => {
			expect(isGitMutation("git -C /tmp/repo reset --hard HEAD")).toBe(true);
			expect(isGitMutation("git -c user.name=x commit -m wip")).toBe(true);
			expect(isGitMutation("git --git-dir=/tmp/repo/.git push --force origin main")).toBe(true);
			expect(isGitMutation("git -C /tmp/repo clean -fd")).toBe(true);
		});

		it("rejects subcommands mag treats as mutations (not in the read-only allowlist)", () => {
			for (const command of [
				"git ls-files",
				"git ls-remote",
				"git ls-tree HEAD",
				"git cat-file -p HEAD",
				"git blame src/foo.ts",
				"git grep TODO",
				"git shortlog",
				"git whatchanged",
				"git remote -v",
				"git tag -l",
				"git config --get user.name",
				"git remote show origin",
				"git branch -d stale",
			]) {
				expect(isGitMutation(command)).toBe(true);
			}
		});

		it("rejects git without a recognizable subcommand", () => {
			expect(isGitMutation("git")).toBe(true);
		});
	});

	describe("git branch --set-upstream-to is a mutation (F-GIT-1)", () => {
		it("isGitMutation true for --set-upstream-to", () => {
			expect(isGitMutation("git branch --set-upstream-to=origin/main")).toBe(true);
			expect(isGitMutation("git branch -u origin/main")).toBe(true);
			expect(isGitMutation("git branch --set-upstream-to origin/main feature")).toBe(true);
		});

		it("classifyShellCommand returns forbidden for --set-upstream-to", () => {
			expect(classifyShellCommand("git branch --set-upstream-to=origin/main").level).toBe("forbidden");
			expect(classifyShellCommand("git branch -u origin/main").level).toBe("forbidden");
		});

		it("read-only branch flags remain readonly and forbidden subcommands stay forbidden", () => {
			expect(isGitMutation("git branch")).toBe(false);
			expect(isGitMutation("git branch -a")).toBe(false);
			expect(isGitMutation("git branch --show-current")).toBe(false);
			expect(isGitMutation("git branch -vv")).toBe(false);
			expect(isGitMutation("git branch --format='%(refname)'")).toBe(false);
			expect(isGitMutation("git branch -m old new")).toBe(true);
			expect(isGitMutation("git branch -d stale")).toBe(true);
			expect(isGitMutation("git branch -c src copy")).toBe(true);
		});
	});

	describe("bare colon shell sentinel (G-S1-1)", () => {
		it("classifies a bare colon as forbidden", () => {
			expect(classifyShellCommand(":").level).toBe("forbidden");
		});

		it("classifies a nested bare colon as forbidden", () => {
			expect(classifyShellCommand("bash -c ':'").level).toBe("forbidden");
		});

		it("leaves other commands unchanged", () => {
			expect(classifyShellCommand("true").level).not.toBe("forbidden");
		});
	});
});
