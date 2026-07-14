import { ambientDefine } from "../projection/projection.ts";

export interface SessionOptions {
	disableShellSafeguards: boolean;
	disableCwdSafeguards: boolean;
	timezone: string | null;
	vcsAvailable: boolean;
	headless: boolean;
	solo: boolean;
}

export const SessionOptionsAmbient = ambientDefine<SessionOptions>({
	name: "SessionOptions",
	initial: {
		disableShellSafeguards: false,
		disableCwdSafeguards: false,
		timezone: null,
		vcsAvailable: true,
		headless: false,
		solo: false,
	},
});

export const DEFAULT_SESSION_OPTIONS: SessionOptions = {
	disableShellSafeguards: false,
	disableCwdSafeguards: false,
	timezone: null,
	vcsAvailable: true,
	headless: false,
	solo: false,
};
