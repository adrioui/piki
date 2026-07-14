/**
 * Turn-layer types for the harness.
 */

// ── Turn-level streaming events ──────────────────────────────────

export interface ThoughtDelta {
	readonly type: "ThoughtDelta";
	readonly text: string;
	readonly [key: string]: unknown;
}

export interface MessageDelta {
	readonly type: "MessageDelta";
	readonly text: string;
	readonly [key: string]: unknown;
}

// ── Outcome (closed discriminated union) ────────────────────────
// Concrete turn outcomes. Exhaustively checked in reducers and consumers.

export type Outcome =
	| { readonly _tag: "Completed"; readonly toolCallsCount: number; readonly requestId: string }
	| { readonly _tag: "OutputTruncated"; readonly requestId: string }
	| { readonly _tag: "ContentFiltered"; readonly requestId: string }
	| { readonly _tag: "StreamFailed"; readonly message: string; readonly terminal: unknown; readonly requestId: string }
	| { readonly _tag: "EngineDefect"; readonly message: string; readonly requestId?: string }
	| { readonly _tag: "Interrupted"; readonly requestId?: string }
	| {
			readonly _tag: "GateRejected";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly requestId?: string;
	  }
	| {
			readonly _tag: "ToolExecutionError";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
			readonly error: unknown;
			readonly requestId?: string;
	  }
	| { readonly _tag: "ThoughtLimitExceeded"; readonly limit: number; readonly requestId?: string }
	| {
			readonly _tag: "ToolInputValidationFailure";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
			readonly issue: unknown;
			readonly requestId?: string;
	  };

// ── Usage ────────────────────────────────────────────────────────

export interface Usage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens?: number;
}

// ── Turn-end event ───────────────────────────────────────────────

export interface TurnEnd {
	readonly type: "TurnEnd";
	readonly outcome: Outcome;
	readonly usage: Usage | null;
	readonly [key: string]: unknown;
}

// ── Tool lifecycle events ────────────────────────────────────────

export interface ToolInputStarted {
	readonly type: "ToolInputStarted";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly toolName: string;
	readonly toolKey: string;
	readonly [key: string]: unknown;
}

export interface ToolInputFieldChunk {
	readonly type: "ToolInputFieldChunk";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly field: string;
	readonly path: readonly string[];
	readonly delta: string;
	readonly [key: string]: unknown;
}

export interface ToolInputFieldComplete {
	readonly type: "ToolInputFieldComplete";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly field: string;
	readonly path: readonly string[];
	readonly value: unknown;
	readonly [key: string]: unknown;
}

export interface ToolInputReady {
	readonly type: "ToolInputReady";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly [key: string]: unknown;
}

export interface ToolInputRejected {
	readonly type: "ToolInputRejected";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly toolName: string;
	readonly toolKey: string;
	readonly issue: unknown;
	readonly [key: string]: unknown;
}

export interface ToolExecutionStarted {
	readonly type: "ToolExecutionStarted";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly toolName: string;
	readonly toolKey: string;
	readonly input: unknown;
	readonly cached: boolean;
	readonly [key: string]: unknown;
}

export interface ToolExecutionEnded {
	readonly type: "ToolExecutionEnded";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly toolName: string;
	readonly toolKey: string;
	readonly result: unknown;
	readonly [key: string]: unknown;
}

export interface ToolEmission {
	readonly type: "ToolEmission";
	readonly toolCallId: string;
	readonly providerToolCallId: string;
	readonly toolName: string;
	readonly toolKey: string;
	readonly value: unknown;
	readonly [key: string]: unknown;
}

// ── Union of all events the turn reducers handle ─────────────────
// Closed literal union — no index signature so exhaustiveness is enforced.
// Individual interfaces preserve literal property types for narrowing.

export type TurnEvent =
	| ({ readonly _tag: "ThoughtDelta"; readonly text: string } & Record<string, unknown>)
	| ({ readonly _tag: "MessageDelta"; readonly text: string } & Record<string, unknown>)
	| ({
			readonly _tag: "ToolInputStarted";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
	  } & Record<string, unknown>)
	| ({
			readonly _tag: "ToolInputFieldChunk";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly field: string;
			readonly path: readonly string[];
			readonly delta: string;
	  } & Record<string, unknown>)
	| ({
			readonly _tag: "ToolInputFieldComplete";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly field: string;
			readonly path: readonly string[];
			readonly value: unknown;
	  } & Record<string, unknown>)
	| ({ readonly _tag: "ToolInputReady"; readonly toolCallId: string; readonly providerToolCallId: string } & Record<
			string,
			unknown
	  >)
	| ({
			readonly _tag: "ToolInputRejected";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
			readonly issue: unknown;
	  } & Record<string, unknown>)
	| ({
			readonly _tag: "ToolExecutionStarted";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
			readonly input: unknown;
			readonly cached: boolean;
	  } & Record<string, unknown>)
	| ({
			readonly _tag: "ToolExecutionEnded";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
			readonly result: unknown;
	  } & Record<string, unknown>)
	| ({
			readonly _tag: "ToolEmission";
			readonly toolCallId: string;
			readonly providerToolCallId: string;
			readonly toolName: string;
			readonly toolKey: string;
			readonly value: unknown;
	  } & Record<string, unknown>)
	| ({ readonly _tag: "TurnEnd"; readonly outcome: Outcome; readonly usage: Usage | null } & Record<string, unknown>);

// ── Tool-call part inside AssistantMessage ───────────────────────

export interface ToolCallPart {
	readonly _tag: "ToolCallPart";
	readonly id: string;
	readonly providerToolCallId: string | undefined;
	readonly name: string;
	readonly input: Record<string, unknown>;
}

// ── AssistantMessage ─────────────────────────────────────────────

export interface AssistantMessage {
	readonly _tag: "AssistantMessage";
	readonly reasoning?: string;
	readonly text?: string;
	readonly toolCalls?: readonly ToolCallPart[];
}

// ── Tool result ──────────────────────────────────────────────────

export interface ToolResult {
	readonly toolCallId: string;
	readonly providerToolCallId: string | undefined;
	readonly toolName: string;
	readonly result: unknown;
}

// ── Canonical accumulator (internal, full fidelity) ─────────────

export interface CanonicalAccumulatorState {
	readonly reasoning: string;
	readonly messageText: string;
	readonly toolCallMeta: ReadonlyMap<string, ToolCallMeta>;
	readonly toolCallInputs: ReadonlyMap<string, unknown>;
	readonly toolCallInputChunks: ReadonlyMap<string, unknown>;
	readonly readyToolCalls: ReadonlySet<string>;
	readonly assistantMessage: AssistantMessage;
	readonly toolResults: ToolResult[];
	readonly outcome: Outcome | null;
	readonly usage: Usage | null;
}

export interface ToolCallMeta {
	readonly providerToolCallId: string;
	readonly toolName: string;
	readonly toolKey: string;
}

// ── Canonical projection (public shape consumers see) ────────────

export interface CanonicalProjection {
	readonly assistantMessage: AssistantMessage;
	readonly toolResults: ToolResult[];
	readonly outcome: Outcome | null;
	readonly usage: Usage | null;
}

// ── Engine state ─────────────────────────────────────────────────

export type EngineToolOutcome =
	| {
			readonly _tag: "Completed";
			readonly result: unknown;
	  }
	| {
			readonly _tag: "InputRejected";
	  };

export interface EngineState {
	readonly toolCallMap: ReadonlyMap<string, string>;
	readonly toolOutcomes: ReadonlyMap<string, EngineToolOutcome>;
	readonly deadToolCalls: ReadonlySet<string>;
	readonly stopped: boolean;
}

// ── Composite turn state ─────────────────────────────────────────

export interface TurnState {
	readonly _accumulator: CanonicalAccumulatorState;
	readonly canonical: CanonicalProjection;
	readonly engine: EngineState;
	readonly handles: ReadonlyMap<string, unknown>;
}

// ── Reducer protocol ─────────────────────────────────────────────

export interface Reducer<S> {
	readonly initial: S;
	readonly step: (state: S, event: TurnEvent) => S;
}
