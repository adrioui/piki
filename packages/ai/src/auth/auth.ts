/**
 * Auth helpers.
 */

export const Auth = {
	bearer: (token: string) => (headers: Headers) => {
		headers.set("Authorization", `Bearer ${token}`);
	},
	header: (name: string, value: string) => (headers: Headers) => {
		headers.set(name, value);
	},
	none: () => {},
};
