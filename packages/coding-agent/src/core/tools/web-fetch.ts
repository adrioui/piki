/**
 * Web Fetch Tool — fetches URL content and returns cleaned markdown.
 * Truncates to a configurable max length (default: 10000 chars).
 */

import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import type { AgentToolResult } from "@piki/agent-core";
import { type Static, Type } from "typebox";
import { Agent, fetch as undiciFetch } from "undici";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

const webFetchSchema = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
	maxLength: Type.Optional(Type.Number({ description: "Maximum content length in characters (default: 10000)" })),
});

export type WebFetchInput = Static<typeof webFetchSchema>;
type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

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

export function isPrivateIp(ip: string): boolean {
	const version = isIP(ip);
	if (version === 4) {
		const parts = ip.split(".").map(Number);
		return (
			parts[0] === 10 ||
			parts[0] === 127 ||
			(parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) ||
			(parts[0] === 192 && parts[1] === 168) ||
			(parts[0] === 169 && parts[1] === 254) ||
			parts[0] === 0
		);
	}
	if (version === 6) {
		const lower = ip.toLowerCase();
		return (
			lower === "::1" ||
			lower.startsWith("fe80:") ||
			lower.startsWith("fc") ||
			lower.startsWith("fd") ||
			lower.startsWith("::ffff:")
		);
	}
	return false;
}

export function isBlockedUrl(urlStr: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(urlStr);
	} catch {
		return true;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
	if (parsed.username || parsed.password) return true;
	const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (isIP(hostname) !== 0) {
		return isPrivateIp(hostname);
	}
	if (
		hostname === "localhost" ||
		hostname === "0.0.0.0" ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal")
	) {
		return true;
	}
	return false;
}

async function resolveAllowedAddresses(urlStr: string): Promise<LookupAddress[] | undefined> {
	let parsed: URL;
	try {
		parsed = new URL(urlStr);
	} catch {
		throw new Error(`Blocked URL "${urlStr}" by SSRF protection`);
	}
	const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (isIP(hostname) !== 0) return undefined;
	const addresses = await lookup(hostname, { all: true });
	if (addresses.length === 0 || addresses.some((address) => isPrivateIp(address.address))) {
		throw new Error(`Blocked URL "${urlStr}" by SSRF protection`);
	}
	return addresses;
}

export async function isBlockedUrlResolved(urlStr: string): Promise<boolean> {
	if (isBlockedUrl(urlStr)) return true;
	try {
		await resolveAllowedAddresses(urlStr);
		return false;
	} catch {
		return true;
	}
}

function createPinnedDispatcher(addresses: readonly LookupAddress[]): Agent {
	let nextIndex = 0;
	const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
		if (options.all) {
			callback(
				null,
				addresses.map((address) => ({ address: address.address, family: address.family })),
			);
			return;
		}
		const selected = addresses[nextIndex % addresses.length]!;
		nextIndex++;
		callback(null, selected.address, selected.family);
	};
	return new Agent({ connect: { lookup: pinnedLookup } });
}

interface ValidatedFetchResponse {
	response: UndiciResponse;
	close: () => Promise<void>;
}

async function fetchOnceWithPinnedDns(url: string, signal: AbortSignal): Promise<ValidatedFetchResponse> {
	if (isBlockedUrl(url)) {
		throw new Error(`Blocked URL "${url}" by SSRF protection`);
	}
	const addresses = await resolveAllowedAddresses(url);
	const dispatcher = addresses ? createPinnedDispatcher(addresses) : undefined;
	try {
		const response = await undiciFetch(url, {
			dispatcher,
			headers: { "User-Agent": "Mozilla/5.0 (compatible; pi-agent/1.0)" },
			signal,
			redirect: "manual",
		});
		return {
			response,
			close: async () => {
				await dispatcher?.close();
			},
		};
	} catch (err) {
		await dispatcher?.close();
		throw err;
	}
}

async function fetchWithValidatedRedirects(url: string, signal: AbortSignal): Promise<ValidatedFetchResponse> {
	let currentUrl = url;
	for (let redirectCount = 0; redirectCount < 5; redirectCount++) {
		const result = await fetchOnceWithPinnedDns(currentUrl, signal);
		const { response } = result;
		if (![301, 302, 303, 307, 308].includes(response.status)) {
			return result;
		}
		const location = response.headers.get("location");
		if (!location) return result;
		await response.body?.cancel();
		await result.close();
		currentUrl = new URL(location, currentUrl).toString();
	}
	throw new Error("Too many redirects");
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
			const maxLength = Math.min(Math.max(params.maxLength ?? 10000, 1), 50000);
			let timeout: NodeJS.Timeout | undefined;
			let fetchResult: ValidatedFetchResponse | undefined;
			try {
				const controller = new AbortController();
				timeout = setTimeout(() => controller.abort(), 30000);
				if (signal) {
					signal.addEventListener("abort", () => controller.abort(), { once: true });
				}

				fetchResult = await fetchWithValidatedRedirects(params.url, controller.signal);
				const { response } = fetchResult;

				if (!response.ok) {
					await response.body?.cancel();
					throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
				}

				const contentType = response.headers.get("content-type") ?? "";
				if (!/^text\/|application\/(json|xml|xhtml\+xml)/i.test(contentType)) {
					await response.body?.cancel();
					throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
				}
				const body = await response.text();
				const text = contentType.includes("text/html") ? stripHtml(body) : body;
				const truncated = text.slice(0, maxLength);
				const suffix = text.length > maxLength ? "\n\n[... truncated]" : "";

				return {
					content: [{ type: "text", text: truncated + suffix }],
					details: { url: params.url, contentLength: text.length, truncated: text.length > maxLength },
				};
			} catch (err) {
				if (err instanceof Error) throw err;
				throw new Error(String(err));
			} finally {
				await fetchResult?.close();
				if (timeout) clearTimeout(timeout);
			}
		},
	};
}
