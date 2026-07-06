export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.PIKI_EXPERIMENTAL === "1";
}
