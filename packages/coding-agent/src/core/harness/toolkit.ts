import type { HarnessTool } from "./types.ts";

type StoredHarnessTool = unknown;
type AnyHarnessTool = HarnessTool<unknown, unknown, unknown>;

export class Toolkit {
	private readonly tools = new Map<string, StoredHarnessTool>();

	register<TInput, TOutput, TError>(tool: HarnessTool<TInput, TOutput, TError>): void {
		this.tools.set(tool.definition.name, tool);
	}

	get(name: string): AnyHarnessTool | undefined {
		return this.tools.get(name) as AnyHarnessTool | undefined;
	}

	list(): AnyHarnessTool[] {
		return [...this.tools.values()] as AnyHarnessTool[];
	}

	pick(names: readonly string[]): Toolkit {
		const next = new Toolkit();
		for (const name of names) {
			const tool = this.get(name);
			if (tool) next.register(tool);
		}
		return next;
	}

	omit(names: readonly string[]): Toolkit {
		const omitted = new Set(names);
		const next = new Toolkit();
		for (const tool of this.list()) {
			if (!omitted.has(tool.definition.name)) next.register(tool);
		}
		return next;
	}

	merge(other: Toolkit): Toolkit {
		const next = new Toolkit();
		for (const tool of this.list()) next.register(tool);
		for (const tool of other.list()) next.register(tool);
		return next;
	}
}

export function createToolkit<TInput, TOutput, TError>(
	tools: readonly HarnessTool<TInput, TOutput, TError>[] = [],
): Toolkit {
	const toolkit = new Toolkit();
	for (const tool of tools) toolkit.register(tool);
	return toolkit;
}

export function mergeToolkits(...toolkits: readonly Toolkit[]): Toolkit {
	let merged = new Toolkit();
	for (const toolkit of toolkits) {
		merged = merged.merge(toolkit);
	}
	return merged;
}

export { type ExpandedPath, expandScratchpadPath } from "@piki/scratchpad";
