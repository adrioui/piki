import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export interface ToolResultForModel {
	content: (TextContent | ImageContent)[];
	details: unknown;
}

export function formatToolResultForModel(
	toolName: string,
	args: unknown,
	result: ToolResultForModel,
	isError: boolean,
): (TextContent | ImageContent)[] | undefined {
	if (isError) {
		return undefined;
	}
	const text = result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n")
		.trim();
	if (text.length === 0) {
		return undefined;
	}

	if (toolName === "read") {
		return undefined;
	}

	if (toolName === "bash") {
		if (text.startsWith("[bash]")) {
			return undefined;
		}
		const command = getStringArg(args, "command");
		return [{ type: "text", text: command ? `[bash] $ ${command}\n${text}` : `[bash]\n${text}` }];
	}

	if (toolName === "edit") {
		if (text.startsWith("[edit]")) {
			return undefined;
		}
		const path = getStringArg(args, "file_path") ?? getStringArg(args, "path");
		return [{ type: "text", text: path ? `[edit] ${path}\n${text}` : `[edit]\n${text}` }];
	}

	if (toolName === "write") {
		if (text.startsWith("[write]")) {
			return undefined;
		}
		const path = getStringArg(args, "file_path") ?? getStringArg(args, "path");
		return [{ type: "text", text: path ? `[write] ${path}\n${text}` : `[write]\n${text}` }];
	}

	return undefined;
}

function getStringArg(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== "object") {
		return undefined;
	}
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}
