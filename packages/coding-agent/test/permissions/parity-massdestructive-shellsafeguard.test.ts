/**
 * Focused parity tests for the Wave-6 mass-destructive (P1) and shell-safeguard
 * under/over-block (P2/P3) fixes, verified against Magnitude alpha22:
 *   - P1: mass-destructive two-phase model (denyMassDestructiveIn) honoring the
 *     /tmp,/dev/null outside-prefix exemption; within-cwd/scratch/tmp allowed,
 *     protected-root (~/.piki, the piki rebrand of ~/.magnitude) denied, escape
 *     falls through to the cwd write-boundary (denyWritesOutside).
 *   - P2: tool under-blocks closed (kubectl set, helm test + nested mutating
 *     subcommands, power/partition/firewall, kill PID 1, pkill broad-name
 *     hard-kills, gradlew publish, twine upload, createuser/dropuser, OS package
 *     managers destructive subcommands, rsync --delete).
 *   - P3: `mount` keeps piki's stricter critical-path-only block (intentional).
 */

import { describe, expect, it } from "vitest";
import { evaluatePermission } from "../../src/core/permissions/permission-gate.ts";
import { classifyShellCommand } from "../../src/core/permissions/shell-classifier.ts";

const CWD = "/home/user/project";

describe("P1 — mass-destructive two-phase (alpha22 denyMassDestructiveIn)", () => {
	it("allows mass-destructive within cwd", () => {
		expect(evaluatePermission("bash", { command: "rm -rf ./build" }, { cwd: CWD }).permitted).toBe(true);
	});

	it("allows mass-destructive at an absolute path inside cwd", () => {
		expect(evaluatePermission("bash", { command: "rm -rf /home/user/project/build" }, { cwd: CWD }).permitted).toBe(
			true,
		);
	});

	it("allows mass-destructive under /tmp (outside-prefix exemption)", () => {
		expect(evaluatePermission("bash", { command: "rm -rf /tmp/x" }, { cwd: CWD }).permitted).toBe(true);
	});

	it("allows mass-destructive under /dev/null except force-delete of system paths", () => {
		// mag forbids `rm -rf /dev/null/x` (force-deleting a system path) at the
		// forbidden tier, which fires before the /dev/null outside-prefix exemption.
		const d = evaluatePermission("bash", { command: "rm -rf /dev/null/x" }, { cwd: CWD });
		expect(d.permitted).toBe(false);
		expect(d.reason).toMatch(/system paths/i);
	});

	it("denies mass-destructive inside the protected ~/.piki root", () => {
		const d = evaluatePermission("bash", { command: "rm -rf ~/.piki/x" }, { cwd: CWD });
		expect(d.permitted).toBe(false);
		expect(d.reason).toMatch(/protected directories/i);
	});

	it("denies mass-destructive escaping all roots (cwd boundary)", () => {
		const d = evaluatePermission("bash", { command: "rm -rf /etc/x" }, { cwd: CWD });
		expect(d.permitted).toBe(false);
		expect(d.reason).toMatch(/outside allowed directories|protected directories|system paths/i);
	});

	it("rsync --delete is mass-destructive and honors the same roots", () => {
		expect(classifyShellCommand("rsync --delete src/ dst/").level).toBe("mass-destructive");
		expect(evaluatePermission("bash", { command: "rsync --delete /etc /tmp/x" }, { cwd: CWD }).permitted).toBe(false);
		expect(evaluatePermission("bash", { command: "rsync --delete ./a ./b" }, { cwd: CWD }).permitted).toBe(true);
	});

	it("disableShellSafeguards lifts the mass-destructive classifier but the cwd boundary stays independent", () => {
		// disableShellSafeguards alone does NOT bypass the cwd write-boundary.
		const boundary = evaluatePermission(
			"bash",
			{ command: "rm -rf /etc/x" },
			{ cwd: CWD, disableShellSafeguards: true, knownTools: ["bash"] },
		);
		expect(boundary.permitted).toBe(false);
		// Only with BOTH safeguards disabled does an escape become permitted.
		const both = evaluatePermission(
			"bash",
			{ command: "rm -rf /etc/x" },
			{ cwd: CWD, disableShellSafeguards: true, disableCwdSafeguards: true, knownTools: ["bash"] },
		);
		expect(both.permitted).toBe(true);
		// Within-cwd mass-destructive is permitted regardless (classifier allows it).
		const within = evaluatePermission(
			"bash",
			{ command: "rm -rf ./build" },
			{ cwd: CWD, disableShellSafeguards: true, knownTools: ["bash"] },
		);
		expect(within.permitted).toBe(true);
	});
});

describe("P2 — shell safeguard under-blocks aligned to mag", () => {
	it("blocks kubectl set / auth reconcile / certificate approve", () => {
		for (const c of ["kubectl set image deploy/x y", "kubectl auth reconcile", "kubectl certificate approve csr/x"]) {
			expect(classifyShellCommand(c).level, c).toBe("forbidden");
		}
	});

	it("blocks helm test and nested mutating subcommands, allows read-style", () => {
		for (const c of [
			"helm test",
			"helm install f b",
			"helm upgrade f b",
			"helm uninstall f",
			"helm rollback f 1",
			"helm repo add x y",
			"helm repo remove x",
			"helm repo update",
			"helm plugin install x",
			"helm plugin uninstall x",
			"helm plugin update x",
			"helm registry login x",
			"helm registry logout x",
			"helm push x",
			"helm --force install f b",
		]) {
			expect(classifyShellCommand(c).level, c).toBe("forbidden");
		}
		for (const c of [
			"helm list",
			"helm template f",
			"helm lint f",
			"helm get values f",
			"helm repo list",
			"helm plugin list",
			"helm status f",
		]) {
			expect(classifyShellCommand(c).level, c).toBe("normal");
		}
	});

	it("blocks power / partition / firewall commands", () => {
		for (const c of [
			"shutdown",
			"reboot",
			"poweroff",
			"halt",
			"parted /dev/sdx",
			"iptables -F",
			"nft list ruleset",
			"ufw disable",
			"firewall-cmd --reload",
		]) {
			expect(classifyShellCommand(c).level, c).toBe("forbidden");
		}
	});

	it("blocks kill of PID 1 but allows task-specific PIDs", () => {
		expect(classifyShellCommand("kill -9 1").level).toBe("forbidden");
		expect(classifyShellCommand("kill 12345").level).toBe("normal");
	});

	it("blocks pkill/killall hard-kill of broad names but allows narrow", () => {
		for (const c of ["pkill -9 node", "killall -9 python", "pkill -9 java", "pkill -9 sh"]) {
			expect(classifyShellCommand(c).level, c).toBe("forbidden");
		}
		expect(classifyShellCommand("pkill node").level).toBe("normal");
		expect(classifyShellCommand("pkill -9 myworker").level).toBe("normal");
	});

	it("blocks gradlew publish and twine upload", () => {
		expect(classifyShellCommand("gradlew publish").level).toBe("forbidden");
		expect(classifyShellCommand("twine upload dist").level).toBe("forbidden");
	});

	it("blocks createuser/dropuser DB utilities", () => {
		for (const c of ["createuser bob", "dropuser bob"]) {
			expect(classifyShellCommand(c).level, c).toBe("forbidden");
		}
	});

	it("blocks OS package-manager destructive subcommands", () => {
		for (const c of [
			"apt remove vim",
			"apt-get purge vim",
			"apt autoremove",
			"yum remove x",
			"dnf remove x",
			"pacman remove x",
			"snap remove x",
			"brew cleanup",
			"brew services stop x",
			"brew services cleanup",
		]) {
			expect(classifyShellCommand(c).level, c).toBe("forbidden");
		}
		for (const c of ["apt install vim", "yum install x", "brew install x"]) {
			expect(classifyShellCommand(c).level, c).toBe("normal");
		}
	});

	it("blocks systemctl/service rescue-power and critical-service stop/disable", () => {
		expect(classifyShellCommand("systemctl poweroff").level).toBe("forbidden");
		expect(classifyShellCommand("systemctl stop network").level).toBe("forbidden");
		expect(classifyShellCommand("systemctl disable docker").level).toBe("forbidden");
		expect(classifyShellCommand("service sshd stop").level).toBe("forbidden");
		expect(classifyShellCommand("systemctl status x").level).toBe("normal");
		expect(classifyShellCommand("systemctl enable docker").level).toBe("normal");
		expect(classifyShellCommand("service nginx status").level).toBe("normal");
	});
});

describe("S11 — force-delete of system dirs forbidden (mag SYSTEM_DIRS)", () => {
	it("forbids `rm -rf <system dir>` with no cwd (headless escape closed)", () => {
		const d = evaluatePermission("bash", { command: "rm -rf /etc" }, { knownTools: ["bash"] });
		expect(d.permitted).toBe(false);
	});

	it("classifyShellCommand forbids force-delete of each system dir", () => {
		for (const c of [
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
		]) {
			expect(classifyShellCommand(c).level, c).toBe("forbidden");
		}
	});

	it("classifyShellCommand forbids force-delete of system dir descendants", () => {
		for (const c of ["rm -rf /etc/shadow", "rm -rf /usr/local/bin", "rm -rf /var/log", "rm -rf /dev/null/x"]) {
			expect(classifyShellCommand(c).level, c).toBe("forbidden");
		}
	});

	it("does NOT forbid non-force recursive rm of system dirs (mag hasForce)", () => {
		for (const c of ["rm -r /etc", "rm -R /usr"]) {
			expect(classifyShellCommand(c).level, c).not.toBe("forbidden");
		}
	});

	it("does NOT forbid non-recursive rm of a system file (mag hasForce)", () => {
		expect(classifyShellCommand("rm /etc/passwd").level).not.toBe("forbidden");
	});

	it("forbidden tier survives disableShellSafeguards but not both safeguards off", () => {
		const boundary = evaluatePermission(
			"bash",
			{ command: "rm -rf /etc/x" },
			{ cwd: CWD, disableShellSafeguards: true, knownTools: ["bash"] },
		);
		expect(boundary.permitted).toBe(false);
		const both = evaluatePermission(
			"bash",
			{ command: "rm -rf /etc/x" },
			{ cwd: CWD, disableShellSafeguards: true, disableCwdSafeguards: true, knownTools: ["bash"] },
		);
		expect(both.permitted).toBe(true);
	});
});
