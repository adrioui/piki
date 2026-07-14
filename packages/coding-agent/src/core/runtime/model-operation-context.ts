import { Context } from "effect";

export interface AgentModelOperationContext {
	operationKind: string;
	operationId: string;
	chainId: string;
	forkId: string | null;
}

export const AgentModelOperationContextTag = Context.GenericTag<AgentModelOperationContext>(
	"@piki/AgentModelOperationContext",
);
