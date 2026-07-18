/**
 * Scientist audit (wave 2, shell/git/pkg-mgr/container/db/sysadmin safeguards).
 *
 * Compares piki `shell-classifier.ts` + `permission-gate.ts` against Magnitude
 * alpha22 bundle `magnitude-alpha22.embedded.js`.
 *
 * This file:
 *  - Locks in the ALREADY-CORRECT parity cases (required deterministic checks).
 *  - Records the discovered DIVERGENCES from mag as `it.skip(...)` so the
 *    Architect can unskip + fix (see report: scratchpad/reports/sci-shell-wave2.md).
 *    Those skipped tests assert MAG-PARITY behavior (the target), not piki's
 *    current (divergent) behavior.
 *
 * Run: node ../../node_modules/vitest/dist/cli.js --run test/permissions/sci-shell-wave2.test.ts
 */

import { describe, expect, it } from "vitest";
import { evaluatePermission } from "../../src/core/permissions/permission-gate.ts";
import { classifyShellCommand, isGitMutation } from "../../src/core/permissions/shell-classifier.ts";

const CWD = "/home/user/project";

describe("required deterministic assertions (parity, correct)", () => {
	it("isGitMutation blocks `git -c user.name=x status`", () => {
		expect(isGitMutation("git -c user.name=x status")).toBe(true);
	});

	it("evaluatePermission permits `rm -rf ./build` within cwd", () => {
		const d = evaluatePermission("bash", { command: "rm -rf ./build" }, { cwd: CWD });
		expect(d.permitted).toBe(true);
	});

	it("evaluatePermission denies `rm -rf /etc/x` (escapes roots)", () => {
		const d = evaluatePermission("bash", { command: "rm -rf /etc/x" }, { cwd: CWD });
		expect(d.permitted).toBe(false);
	});

	it("evaluatePermission denies `npm publish`", () => {
		const d = evaluatePermission("bash", { command: "npm publish" }, { cwd: CWD });
		expect(d.permitted).toBe(false);
	});
});

describe("divergence GAP-1: container host-namespace flags `--net=host` / `--userns=host` UNDER-blocked", () => {
	// mag HOST_NAMESPACE_FLAGS (embedded.js:79359+) = [
	//   --pid=host, --ipc=host, --uts=host, --userns=host, --network=host, --net=host ]
	// piki HOST_NAMESPACE_FLAGS (shell-classifier.ts) = [
	//   --pid=host, --ipc=host, --uts=host, --network=host ]  -> MISSING --userns=host AND --net=host
	// Result: piki classifies `docker run --net=host` / `--userns=host` as normal
	// (allowed), while mag returns HOST_NAMESPACE_REASON (forbidden).
	it("docker run --net=host should be forbidden (mag parity)", () => {
		expect(classifyShellCommand("docker run --net=host nginx").level).toBe("forbidden");
	});
	it("docker run --userns=host should be forbidden (mag parity)", () => {
		expect(classifyShellCommand("docker run --userns=host nginx").level).toBe("forbidden");
	});
	it("podman run --userns=host should be forbidden (mag parity)", () => {
		expect(classifyShellCommand("podman run --userns=host nginx").level).toBe("forbidden");
	});
	it("sanity: piki DOES block the flags it has (non-divergent)", () => {
		expect(classifyShellCommand("docker run --network=host nginx").level).toBe("forbidden");
		expect(classifyShellCommand("docker run --pid=host nginx").level).toBe("forbidden");
		expect(classifyShellCommand("docker run --uts=host nginx").level).toBe("forbidden");
	});
	it("new host-namespace flags --net=host and --userns=host are forbidden for docker/podman/nerdctl", () => {
		expect(classifyShellCommand("docker run --net=host nginx").level).toBe("forbidden");
		expect(classifyShellCommand("docker run --userns=host nginx").level).toBe("forbidden");
		expect(classifyShellCommand("podman run --net=host nginx").level).toBe("forbidden");
		expect(classifyShellCommand("podman run --userns=host nginx").level).toBe("forbidden");
		expect(classifyShellCommand("nerdctl run --net=host nginx").level).toBe("forbidden");
		expect(classifyShellCommand("nerdctl run --userns=host nginx").level).toBe("forbidden");
	});
});

describe("divergence GAP-2: `gcloud config set` / `az config set` OVER-blocked (piki stricter than mag)", () => {
	// mag isGcloudForbidden (embedded.js:79563): `if (top === "config") return null;`
	//   -> `gcloud config set ...` is ALLOWED by mag.
	// piki classifyCloud (shell-classifier.ts): only special-cases `gcloud auth`,
	//   then falls into the generic mutatingPrefixes check which includes "set",
	//   so `gcloud config set project foo` -> forbidden. Same for `az config set`.
	// Classification: piki STRICTER (acceptable if documented-intentional), but it
	// is a behavioral divergence from mag that the Architect must decide to keep
	// or relax. Marked skip so a deliberate decision is recorded.
	it.skip("gcloud config set allowed by mag -> piki must decide (currently forbidden)", () => {
		// mag: normal. piki: forbidden. Documented-intentional-stricter? Architect call.
		expect(classifyShellCommand("gcloud config set project foo").level).not.toBe("forbidden");
	});
	it.skip("az config set allowed by mag -> piki must decide (currently forbidden)", () => {
		expect(classifyShellCommand("az config set foo bar").level).not.toBe("forbidden");
	});
});

describe("divergence GAP-3: DB export utilities `pg_dump` / `mysqldump` OVER-blocked (piki stricter than mag)", () => {
	// mag isDatabaseUtilityForbidden (embedded.js:79863): only dropdb/dropuser/
	//   createdb/createuser/pg_restore are forbidden; pg_dump & mysqldump return
	//   null (ALLOWED) unless --force + destructive token.
	// piki classifyDbUtility (shell-classifier.ts): blocks the ENTIRE
	//   DB_UTILITY_COMMANDS set, including pg_dump/mysqldump -> forbidden.
	// Classification: piki STRICTER. Safe-direction, but a divergence. Architect call.
	it.skip("pg_dump allowed by mag -> piki must decide (currently forbidden)", () => {
		expect(classifyShellCommand("pg_dump mydb > out.sql").level).not.toBe("forbidden");
	});
	it.skip("mysqldump allowed by mag -> piki must decide (currently forbidden)", () => {
		expect(classifyShellCommand("mysqldump mydb > out.sql").level).not.toBe("forbidden");
	});
});

describe("divergence GAP-4: sysadmin superset `firewall-cmd`/`chroot`/`useradd`/`userdel`/... OVER-blocked (piki stricter)", () => {
	// mag SYSADMIN_ALWAYS_FORBIDDEN (embedded.js:80098) = [
	//   shutdown, reboot, poweroff, halt, fdisk, parted, iptables, nft, ufw ]
	// piki SYSADMIN_ALWAYS_FORBIDDEN (shell-classifier.ts) ADDS:
	//   mkfs, chroot, useradd, userdel, usermod, groupadd, groupdel, firewall-cmd
	//   (mkfs is independently blocked by mag's isForbidden, so mkfs is matched;
	//    chroot/useradd/.../firewall-cmd are piki-only blocks).
	// Classification: piki STRICTER (safe-direction). Behavioral divergence.
	it.skip("firewall-cmd allowed by mag -> piki must decide (currently forbidden)", () => {
		expect(classifyShellCommand("firewall-cmd --reload").level).not.toBe("forbidden");
	});
	it.skip("chroot allowed by mag -> piki must decide (currently forbidden)", () => {
		expect(classifyShellCommand("chroot /mnt /bin/bash").level).not.toBe("forbidden");
	});
	it.skip("useradd allowed by mag -> piki must decide (currently forbidden)", () => {
		expect(classifyShellCommand("useradd -m bob").level).not.toBe("forbidden");
	});
});

describe("parity confirmed MATCH (regression guards)", () => {
	it("git branch empty operands => read-only (matches mag branchIsReadOnly)", () => {
		expect(isGitMutation("git branch")).toBe(false);
		expect(classifyShellCommand("git branch").level).toBe("readonly");
	});
	it("git branch <name> => mutation (branch create is not read-only)", () => {
		expect(isGitMutation("git branch foo")).toBe(true);
	});
	it("gcloud auth non-list blocked, auth list allowed", () => {
		expect(classifyShellCommand("gcloud auth activate-service-account x").level).toBe("forbidden");
		expect(classifyShellCommand("gcloud auth list").level).toBe("readonly");
	});
	it("kubectl -A / --all-namespaces blocked (matches mag KUBECTL_REASON_ALL_NAMESPACES)", () => {
		expect(classifyShellCommand("kubectl get pods -A").level).toBe("forbidden");
	});
	it("helm repo update blocked (matches mag HELM_REASON_REPO_MUTATION)", () => {
		expect(classifyShellCommand("helm repo update").level).toBe("forbidden");
	});
	it("writesStayWithin honors /tmp + /dev/null outside-prefix (matches mag)", () => {
		expect(classifyShellCommand("tee /tmp/x").level).toBe("normal");
	});
});
