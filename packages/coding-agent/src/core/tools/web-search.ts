/**
 * Web Search Tool — searches the web using DuckDuckGo's HTML endpoint.
 * Zero dependency, no API key needed.
 *
 * Returns structured results: Array<{ title, url, snippet }>
 */

import type { AgentToolResult } from "@piki/agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { isBlockedUrlResolved } from "./web-fetch.ts";

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	maxResults: Type.Optional(Type.Number({ description: "Maximum results to return (default: 10)" })),
	schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type WebSearchInput = Static<typeof webSearchSchema>;

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
	const results: SearchResult[] = [];
	const resultBlocks = html.split(
		/class="result results_links results_links_deep web-result"|class="result results_links web-result"/,
	);
	for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
		const block = resultBlocks[i]!;

		const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
		const urlMatch = block.match(/class="result__url"[^>]*href="([^"]+)"/);
		const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+)</);

		if (titleMatch) {
			results.push({
				title: titleMatch[1]!.trim(),
				url: urlMatch ? urlMatch[1]!.trim() : "",
				snippet: snippetMatch ? snippetMatch[1]!.trim() : "",
			});
		}
	}
	return results;
}

async function searchDuckDuckGo(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const proxyUrl =
		process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
	if (proxyUrl && (await isBlockedUrlResolved(proxyUrl))) {
		throw new Error("Proxy URL is blocked by SSRF protection");
	}
	// When using a proxy, pass the raw URL — don't double-encode.
	// The proxy will handle the request to the target URL.
	const fetchUrl = url;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
	if (signal) {
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	try {
		const response = await fetch(fetchUrl, {
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; pi-agent/1.0)",
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Search request failed: ${response.status}`);
		}
		const html = await response.text();
		return parseDuckDuckGoHtml(html, maxResults);
	} finally {
		clearTimeout(timeout);
	}
}

export function createWebSearchToolDefinition(): ToolDefinition<typeof webSearchSchema> {
	return {
		name: "web_search",
		label: "web_search",
		description: "Search the web and return structured results with titles, URLs, and snippets.",
		promptSnippet: "Search the web",
		parameters: webSearchSchema,
		async execute(
			_toolCallId: string,
			params: WebSearchInput,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const maxResults = Math.min(Math.max(params.maxResults ?? 10, 1), 50);
			try {
				const results = await searchDuckDuckGo(params.query, maxResults, signal);
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No results found." }],
						details: { query: params.query, results: [], data: undefined },
					};
				}
				const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
				// `sources` mirrors mag's `sources: Array<{title, url}>` for programmatic consumers.
				// `results` (with snippets) is retained as a piki superset.
				return {
					content: [{ type: "text", text }],
					details: {
						query: params.query,
						results,
						sources: results.map((r) => ({ title: r.title, url: r.url })),
						data: undefined,
					},
				};
			} catch (err) {
				if (err instanceof Error) throw err;
				throw new Error(String(err));
			}
		},
	};
}
