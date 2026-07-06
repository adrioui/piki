/**
 * Amp-style permissions and error classification module.
 */

export {
	classifyByStatus,
	classifyError,
	computeJitteredDelay,
	type ErrorCategory,
	type ErrorClassification,
	formatErrorClassification,
	parseRetryHeaders,
	type RetryHeaders,
} from "./error-classifier.ts";

export {
	checkInputForGuardedPaths,
	GUARDED_PATH_PATTERNS,
	type GuardedPathMatch,
	isGuardedPath,
} from "./guarded-paths.ts";
export {
	evaluatePermission,
	type PermissionAction,
	type PermissionDecision,
	type PermissionGateOptions,
	type PermissionRule,
} from "./permission-gate.ts";
export { getRolePolicyRules } from "./role-policy.ts";
export {
	classifyShellCommand,
	parseShellCommand,
	type ShellClassification,
	type ShellCommandSegment,
	type ShellSafetyLevel,
} from "./shell-classifier.ts";
