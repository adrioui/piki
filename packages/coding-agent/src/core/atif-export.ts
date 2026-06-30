/**
 * ATIF (Agent Trajectory Interchange Format) export.
 * Exports session events to ATIF format (JSON with standardized trajectory fields).
 * Used for inter-agent trajectory exchange.
 */

import type { EventEnvelope } from "@earendil-works/pi-event-core";

interface AtifStep {
	timestamp: string;
	type: string;
	payload: Record<string, unknown>;
}

interface AtifTrajectory {
	format: "atif";
	version: "1.0";
	sessionId: string;
	createdAt: string;
	steps: AtifStep[];
}

export function exportToAtif(
	sessionId: string,
	events: EventEnvelope<string, Record<string, unknown>>[],
): AtifTrajectory {
	return {
		format: "atif",
		version: "1.0",
		sessionId,
		createdAt: new Date().toISOString(),
		steps: events.map((event) => ({
			timestamp: event.timestamp,
			type: event.type,
			payload: event.payload,
		})),
	};
}
