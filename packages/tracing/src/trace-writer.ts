function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** Minimal interface for the settings shape needed by telemetry check. */
export interface TelemetrySettings {
	getEnableInstallTelemetry(): boolean;
}

export function isInstallTelemetryEnabled(
	settingsManager: TelemetrySettings,
	telemetryEnv: string | undefined = process.env.PIKI_TELEMETRY,
): boolean {
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
