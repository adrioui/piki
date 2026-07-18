export type ModelTier = "fast" | "smart" | "smart+thinking" | "smart+high-temp+thinking";

/**
 * Context lens settings that control what context a role receives.
 * Each role can have different budgets and visibility rules.
 */
export interface ContextLens {
	/** Maximum characters for the transcript budget. */
	transcriptBudget: number;
	/** Maximum characters for the project context. */
	projectContextBudget: number;
	/** Whether to include scratchpad/process context. */
	includeScratchpad: boolean;
	/** Whether to include process context (git status, etc.). */
	includeProcess: boolean;
	/** Skill names visible to this role. Empty = all skills visible. */
	visibleSkills: string[];
	/** Skill names excluded for this role. */
	excludedSkills: string[];
}

export interface RoleDef {
	name: string;
	tier: ModelTier;
	maxThoughtChars: number;
	toolkit: "workerBase" | "criticBase" | "observerToolkit" | "compactToolkit";
	webTools: boolean;
	spawnable: boolean;
	icon: string;
	/** Context lens settings for this role. */
	contextLens?: Partial<ContextLens>;
}

export const SPAWNABLE_ROLES = new Set(["scout", "architect", "engineer", "critic", "scientist", "artisan"]);

/** Default context lens applied when a role does not specify one. */
export const DEFAULT_CONTEXT_LENS: ContextLens = {
	transcriptBudget: 50_000,
	projectContextBudget: 10_000,
	includeScratchpad: true,
	includeProcess: true,
	visibleSkills: [],
	excludedSkills: [],
};

/**
 * Merge a role's partial context lens with the default lens.
 * Returns a complete ContextLens with role-specific overrides applied.
 */
export function getRoleContextLens(roleDef: RoleDef): ContextLens {
	const partial = roleDef.contextLens;
	if (!partial) return { ...DEFAULT_CONTEXT_LENS };
	return {
		...DEFAULT_CONTEXT_LENS,
		...partial,
	};
}

export const ROLE_DEFINITIONS: Record<string, RoleDef> = {
	leader: {
		name: "leader",
		tier: "smart",
		maxThoughtChars: 20000,
		toolkit: "workerBase",
		webTools: true,
		spawnable: false,
		icon: "L",
	},
	advisor: {
		name: "advisor",
		tier: "smart",
		maxThoughtChars: 20000,
		toolkit: "compactToolkit",
		webTools: true,
		spawnable: true,
		icon: "V",
	},
	scout: {
		name: "scout",
		tier: "fast",
		maxThoughtChars: 2000,
		toolkit: "workerBase",
		webTools: true,
		spawnable: true,
		icon: "S",
		contextLens: {
			transcriptBudget: 20_000,
			projectContextBudget: 5_000,
			includeScratchpad: false,
			includeProcess: false,
		},
	},
	architect: {
		name: "architect",
		tier: "smart+thinking",
		maxThoughtChars: 20000,
		toolkit: "workerBase",
		webTools: true,
		spawnable: true,
		icon: "A",
	},
	engineer: {
		name: "engineer",
		tier: "fast",
		maxThoughtChars: 20000,
		toolkit: "workerBase",
		webTools: true,
		spawnable: true,
		icon: "E",
	},
	critic: {
		name: "critic",
		tier: "smart+thinking",
		maxThoughtChars: 20000,
		toolkit: "criticBase",
		webTools: false,
		spawnable: true,
		icon: "C",
		contextLens: {
			visibleSkills: [],
			excludedSkills: ["clean-coder"],
		},
	},
	scientist: {
		name: "scientist",
		tier: "smart+thinking",
		maxThoughtChars: 20000,
		toolkit: "workerBase",
		webTools: true,
		spawnable: true,
		icon: "N",
	},
	artisan: {
		name: "artisan",
		tier: "smart",
		maxThoughtChars: 20000,
		toolkit: "workerBase",
		webTools: true,
		spawnable: true,
		icon: "R",
	},
	observer: {
		name: "observer",
		tier: "fast",
		maxThoughtChars: 3000,
		toolkit: "observerToolkit",
		webTools: false,
		spawnable: false,
		icon: "O",
		contextLens: {
			transcriptBudget: 10_000,
			projectContextBudget: 3_000,
			includeScratchpad: false,
			includeProcess: false,
		},
	},
	compact: {
		name: "compact",
		tier: "smart",
		maxThoughtChars: 6000,
		toolkit: "compactToolkit",
		webTools: false,
		spawnable: false,
		icon: "K",
		contextLens: {
			transcriptBudget: 30_000,
			projectContextBudget: 8_000,
			includeScratchpad: true,
			includeProcess: false,
		},
	},
};
