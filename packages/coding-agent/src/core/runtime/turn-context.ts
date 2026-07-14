import { Context } from "effect";

export interface TurnContext {
	turnId: string;
	chainId: string;
	forkId: string | null;
}

export const TurnContextTag = Context.GenericTag<TurnContext>("@piki/TurnContext");
