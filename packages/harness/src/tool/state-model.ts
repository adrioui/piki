/**
 * Define a state model for a tool.
 *
 * Usage:
 *   const myModel = defineStateModel(myTool)<{
 *     initial: { retryCount: number };
 *     reduce: (state, event) => newState;
 *   }>({ ... });
 */
export function defineStateModel(_tool: unknown) {
	return <TConfig extends { initial: Record<string, unknown>; reduce: (state: never, event: never) => never }>(
		config: TConfig,
	) => {
		const initial = Object.freeze({
			phase: "streaming" as const,
			...config.initial,
		});
		return { initial, reduce: config.reduce };
	};
}
