export interface RolePolicy {
	allowWeb: boolean;
	allowMutation: boolean;
	requiresVerification: boolean;
}

export const ROLE_POLICIES = {
	readOnly: {
		allowWeb: false,
		allowMutation: false,
		requiresVerification: true,
	},
	worker: {
		allowWeb: true,
		allowMutation: true,
		requiresVerification: true,
	},
	observer: {
		allowWeb: false,
		allowMutation: false,
		requiresVerification: false,
	},
} as const satisfies Record<string, RolePolicy>;

export type RolePolicyName = keyof typeof ROLE_POLICIES;
