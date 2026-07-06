/**
 * Identical Continue Tracker — prevents duplicate agent.continue() calls with
 * identical context. When the agent is in a stable state (same messages hash),
 * skip the continue to avoid wasted API calls.
 */

import { createHash } from "node:crypto";
import type { AgentMessage } from "@piki/agent-core";

export class IdenticalContinueTracker {
	private lastHash: string | undefined;

	/** Returns true if the context is identical to the last call (should skip). */
	shouldSkip(messages: AgentMessage[]): boolean {
		const hash = this.hashMessages(messages);
		if (this.lastHash === hash) {
			return true;
		}
		this.lastHash = hash;
		return false;
	}

	/** Reset the tracker (called when user input or steering messages arrive). */
	reset(): void {
		this.lastHash = undefined;
	}

	private hashMessages(messages: AgentMessage[]): string {
		const hasher = createHash("sha256");
		for (const msg of messages) {
			hasher.update(msg.role);
			hasher.update(":");
			if ("content" in msg) {
				const content = (msg as { content: unknown }).content;
				if (typeof content === "string") {
					hasher.update(content);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (typeof part === "object" && part !== null && "text" in part) {
							hasher.update(String((part as { text: string }).text));
						}
						if (typeof part === "object" && part !== null && "type" in part) {
							hasher.update(String((part as { type: string }).type));
						}
					}
				}
			} else if ("command" in msg) {
				hasher.update(String((msg as { command: string }).command));
			} else if ("summary" in msg) {
				hasher.update(String((msg as { summary: string }).summary));
			}
			hasher.update("\n");
		}
		return hasher.digest("hex");
	}
}
