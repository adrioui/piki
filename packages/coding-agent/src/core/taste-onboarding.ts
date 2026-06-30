import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TasteOnboardingState {
	completed: boolean;
	skipped: boolean;
	learnedSessions: Record<string, string[]>;
	skippedSessions: Record<string, string[]>;
	lastLearningDate: string;
}

export const DEFAULT_TASTE_ONBOARDING_STATE: TasteOnboardingState = {
	completed: false,
	skipped: false,
	learnedSessions: {},
	skippedSessions: {},
	lastLearningDate: "",
};

export function getTasteOnboardingPath(cwd: string): string {
	return join(cwd, ".pi", "settings.local.json");
}

export function loadTasteOnboardingState(cwd: string): TasteOnboardingState {
	const path = getTasteOnboardingPath(cwd);
	if (!existsSync(path)) return { ...DEFAULT_TASTE_ONBOARDING_STATE };
	try {
		const settings = JSON.parse(readFileSync(path, "utf-8")) as { tasteOnboarding?: Partial<TasteOnboardingState> };
		return { ...DEFAULT_TASTE_ONBOARDING_STATE, ...settings.tasteOnboarding };
	} catch {
		return { ...DEFAULT_TASTE_ONBOARDING_STATE };
	}
}

export function saveTasteOnboardingState(cwd: string, state: TasteOnboardingState): void {
	const path = getTasteOnboardingPath(cwd);
	let settings: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		} catch {
			settings = {};
		}
	}
	settings.tasteOnboarding = state;
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}
