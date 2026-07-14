import type { HarnessTool } from "./tool.ts";

type AnyHarnessTool = HarnessTool<unknown, unknown, unknown>;

export class ToolkitImpl {
	readonly entries: Readonly<Record<string, AnyHarnessTool>>;
	readonly keys: string[];

	constructor(entries: Record<string, AnyHarnessTool>) {
		this.entries = Object.freeze({ ...entries });
		this.keys = Object.keys(entries);
	}

	pick(...names: string[]): ToolkitImpl {
		const picked: Record<string, AnyHarnessTool> = {};
		for (const name of names) {
			if (!(name in this.entries)) {
				throw new Error(`Toolkit.pick: key "${name}" not found. Available: ${this.keys.join(", ")}`);
			}
			picked[name] = this.entries[name]!;
		}
		return new ToolkitImpl(picked);
	}

	omit(...names: string[]): ToolkitImpl {
		const omitSet = new Set(names);
		const remaining: Record<string, AnyHarnessTool> = {};
		for (const key of this.keys) {
			if (!omitSet.has(key)) {
				remaining[key] = this.entries[key]!;
			}
		}
		return new ToolkitImpl(remaining);
	}
}

/** Create a toolkit from a record of harness tools. Matches capture L72033-72064. */
export function defineToolkit(entries: Record<string, AnyHarnessTool>): ToolkitImpl {
	return new ToolkitImpl(entries);
}

/** Merge two toolkits, throwing on duplicate keys. Matches capture L72065-72077. */
export function mergeToolkits(a: ToolkitImpl, b: ToolkitImpl): ToolkitImpl {
	for (const key of b.keys) {
		if (key in a.entries) {
			throw new Error(`mergeToolkits: duplicate key "${key}" found in both toolkits`);
		}
	}
	return new ToolkitImpl({ ...a.entries, ...b.entries });
}
