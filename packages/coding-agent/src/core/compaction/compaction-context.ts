import { Context, Effect, Ref } from "effect";

export interface SubmittedCompactionResult {
	summary: string;
	reflection: string;
	files: string[];
	budgetUsed: number;
	budgetTotal: number;
}

export interface CompactionContext {
	isCompacting: boolean;
	resultRef: Ref.Ref<SubmittedCompactionResult | undefined>;
	maxPayloadTokens: number;
}

export const CompactionContextTag = Context.GenericTag<CompactionContext>("@piki/CompactionContext");

export function makeCompactionContext(options: {
	maxPayloadTokens: number;
	isCompacting?: boolean;
}): Effect.Effect<CompactionContext> {
	return Effect.map(Ref.make<SubmittedCompactionResult | undefined>(undefined), (resultRef) => ({
		isCompacting: options.isCompacting ?? true,
		resultRef,
		maxPayloadTokens: options.maxPayloadTokens,
	}));
}

export function submitCompactionResult(
	context: CompactionContext,
	result: SubmittedCompactionResult,
): Effect.Effect<void> {
	return Ref.set(context.resultRef, result);
}

export function readSubmittedCompactionResult(
	context: CompactionContext,
): Effect.Effect<SubmittedCompactionResult | undefined> {
	return Ref.get(context.resultRef);
}
