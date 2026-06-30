/**
 * Web Fetch Tool — fetches URL content and returns cleaned markdown.
 * Truncates to a configurable max length (default: 10000 chars).
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

const webFetchSchema = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
	maxLength: Type.Optional(Type.Number({ description: "Maximum content length in characters (default: 10000)" })),
});

export type WebFetchInput = Static<typeof webFetchSchema>;

function stripHtml(html: string): string {
	return html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
		.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
		.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<h[1-6][^>]*>/gi, "\n## ")
		.replace(/<\/h[1-6]>/gi, "\n")
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function createWebFetchToolDefinition(): ToolDefinition<typeof webFetchSchema> {
	return {
		name: "web_fetch",
		label: "web_fetch",
		description: "Fetch a URL and return its content as cleaned text. Handles redirects and HTML stripping.",
		promptSnippet: "Fetch a web page",
		parameters: webFetchSchema,
		async execute(
			_toolCallId: string,
			params: WebFetchInput,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const maxLength = params.maxLength ?? 10000;
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 30000);
				if (signal) {
					signal.addEventListener("abort", () => controller.abort(), { once: true });
				}

				const response = await fetch(params.url, {
					headers: { "User-Agent": "Mozilla/5.0 (compatible; pi-agent/1.0)" },
					signal: controller.signal,
					redirect: "follow",
				});
				clearTimeout(timeout);

				if (!response.ok) {
					throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
				}

				const contentType = response.headers.get("content-type") ?? "";
				const body = await response.text();
				const text = contentType.includes("text/html") ? stripHtml(body) : body;
				const truncated = text.slice(0, maxLength);
				const suffix = text.length > maxLength ? "\n\n[... truncated]" : "";

				return {
					content: [{ type: "text", text: truncated + suffix }],
					details: { url: params.url, contentLength: text.length, truncated: text.length > maxLength },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Web fetch failed: ${msg}` }],
					details: { error: true, message: msg },
				};
			}
		},
	};
}
