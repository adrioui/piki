/**
 * Turn-boundary separator injection for the model-facing conversation.
 *
 * This is a byte-identical copy of the helper in
 * `packages/coding-agent/src/core/messages.ts`. The two packages cannot share
 * code without introducing a new cross-package dependency (coding-agent does
 * not depend on `@piki/agent`, and agent must not depend on coding-agent), so
 * the implementation is duplicated to preserve 1:1 parity.
 */
import type { Message } from "@piki/ai/compat";

// Marker injected into the model-facing conversation at each turn boundary.
// Matches the format the leader system prompt advertises and that the snapshot
// boundary parser accepts for checkpoint `since` addressing.
export const TURN_BOUNDARY_PREFIX = "--- ";
export const TURN_BOUNDARY_SUFFIX = " ---";

// Pre-compiled test for an already-injected separator (idempotency guard).
const TURN_BOUNDARY_RE = /^--- \d{1,2}:\d{2}:\d{2} ---$/;

/** Format a turn-boundary separator from an epoch-ms timestamp (local HH:MM:SS). */
export function formatTurnBoundary(timestamp: number): string {
	const d = new Date(timestamp);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${TURN_BOUNDARY_PREFIX}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${TURN_BOUNDARY_SUFFIX}`;
}

function messageText(msg: Message): string {
	const c = msg.content;
	if (typeof c === "string") return c;
	return c.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/**
 * Inject `--- HH:MM:SS ---` turn-boundary separators into the model-facing
 * conversation. A separator is inserted immediately before each `user` message
 * that begins a turn (carries a timestamp) unless the preceding message is
 * already a separator (idempotency guard).
 *
 * Injection happens only in `defaultConvertToLlm` (throwaway per-call output),
 * so the canonical `AgentMessage[]` stays clean and re-serialization across
 * session reload cannot accumulate duplicate separators.
 */
export function injectTurnBoundarySeparators(messages: Message[]): Message[] {
	const out: Message[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const isSeparator = TURN_BOUNDARY_RE.test(messageText(msg));
			const prev = out[out.length - 1];
			const prevIsSeparator = prev !== undefined && prev.role === "user" && TURN_BOUNDARY_RE.test(messageText(prev));
			if (msg.timestamp !== undefined && !isSeparator && !prevIsSeparator) {
				out.push({
					role: "user",
					content: [{ type: "text", text: formatTurnBoundary(msg.timestamp) }],
					timestamp: msg.timestamp,
				});
			}
		}
		out.push(msg);
	}
	return out;
}
