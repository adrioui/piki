import { ambientDefine } from "../projection/projection.ts";

export const SkillsAmbient = ambientDefine<Map<string, unknown>>({
	name: "Skills",
	initial: new Map(),
});
