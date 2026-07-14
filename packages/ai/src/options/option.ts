/**
 * Option definition system.
 */

export interface OptionDef<TValue, _TMapped> {
	_tag: "OptionDef";
	required: boolean;
	default?: TValue;
	map: (value: unknown) => Record<string, unknown>;
}

export const Option3 = {
	define: <TValue, TMapped>(
		map: (value: TValue) => Record<string, unknown>,
		defaultValue?: TValue,
	): OptionDef<TValue, TMapped> => ({
		_tag: "OptionDef",
		required: false,
		default: defaultValue,
		map: (value: unknown) => map(value as TValue),
	}),
	required: <TValue, TMapped>(map: (value: TValue) => Record<string, unknown>): OptionDef<TValue, TMapped> => ({
		_tag: "OptionDef",
		required: true,
		map: (value: unknown) => map(value as TValue),
	}),
};

export function applyOptionDefs(
	defs: Record<string, OptionDef<unknown, unknown>>,
	options: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, def] of Object.entries(defs)) {
		const val = options[key] ?? def.default;
		if (val !== undefined) {
			Object.assign(result, def.map(val));
		}
	}
	return result;
}
