// packages/agent/src/projections/session-context.ts
//
// SessionContextProjection tracks whether the piki session has been
// initialized and carries the bootstrap context object.

import { defineProjection, type EffectProjectionDefinition } from "@piki/event-core";

export interface SessionContextState {
	readonly initialized: boolean;
	readonly context: unknown;
}

export const SessionContextProjection: EffectProjectionDefinition<SessionContextState> =
	defineProjection()<SessionContextState>({
		name: "SessionContext",
		initial: { initialized: false, context: null },
		eventHandlers: {
			session_initialized: ({ event }) => ({
				initialized: true,
				context: event.context,
			}),
			compaction_injected: ({ state }) => state,
		},
	});
