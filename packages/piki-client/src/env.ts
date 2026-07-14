/**
 * Returns true when an environment flag is set to a truthy value.
 * Empty, "0", "false", "no", "off" are treated as off.
 */
export function isEnvFlagOn(value: string | undefined): boolean {
	if (value === undefined) return false;
	const v = value.trim().toLowerCase();
	return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}
