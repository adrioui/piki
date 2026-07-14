export const ROLE_TOOLKITS = {
	workerBase: "workerBase",
	criticBase: "criticBase",
	observerToolkit: "observerToolkit",
	compactToolkit: "compactToolkit",
} as const;

export type RoleToolkit = (typeof ROLE_TOOLKITS)[keyof typeof ROLE_TOOLKITS];
