/**
 * Window render formatters.
 *
 * Provides truncation-aware and permission-aware tool result formatters
 * that bridge the harness formatting layer with the truncation subsystem.
 */

import type { ContentPart, ToolResultContext, ToolResultFormatter } from "@piki/harness";
import { isImageValue } from "@piki/harness";
import { TRUNCATION_TOKEN_LIMIT } from "../../constants.ts";
import { describeShape } from "../../truncation/describe-shape.ts";
import { estimateText } from "../../truncation/estimate.ts";

// ---------------------------------------------------------------------------
// Internal: truncated success formatting
// ---------------------------------------------------------------------------

/**
 * Format a successful tool result as a `<truncated>` block with shape
 * description. Internal helper, not exported.
 */
function formatTruncatedSuccess(entry: ToolResultContext, turnId: string, estimatedTokens: number): ContentPart[] {
	const result = entry.result;
	if (result._tag !== "Success") return [];
	const resultPath = `$M/results/${turnId}_${entry.toolName}.json`;
	const shapeSummary = describeShape(result.output);
	const text = [
		`<truncated path="${resultPath}" estimated_tokens="${estimatedTokens}">`,
		shapeSummary,
		`</truncated>`,
	].join("\n");
	return [{ _tag: "TextPart", text }];
}

// ---------------------------------------------------------------------------
// Public: truncating formatter
// ---------------------------------------------------------------------------

/**
 * Wraps a default tool result formatter to truncate large JSON outputs.
 * When a `Success` result's serialized output exceeds `TRUNCATION_TOKEN_LIMIT`,
 * it renders a `<truncated>` block with shape description instead.
 */
export function createTruncatingFormatter(defaultFormat: ToolResultFormatter, turnId: string): ToolResultFormatter {
	return (entry: ToolResultContext) => {
		const result = entry.result;
		if (result._tag === "Success" && result.output !== undefined && !isImageValue(result.output)) {
			try {
				const serialized = JSON.stringify(result.output, null, 2);
				const estimatedTokens = estimateText(serialized);
				if (estimatedTokens > TRUNCATION_TOKEN_LIMIT) {
					return formatTruncatedSuccess(entry, turnId, estimatedTokens);
				}
			} catch {
				// If serialization fails, fall through to default format
			}
		}
		return defaultFormat(entry);
	};
}

// ---------------------------------------------------------------------------
// Public: agent formatter
// ---------------------------------------------------------------------------

/**
 * Wraps any harness formatter to add permission-rejected rendering.
 * Non-denied results are delegated to the wrapped formatter.
 */
export function createAgentFormatter(harnessFormat: ToolResultFormatter): ToolResultFormatter {
	return (entry: ToolResultContext) => {
		if (entry.result._tag === "Denied") {
			const message = typeof entry.result.denial === "string" ? entry.result.denial : String(entry.result.denial);
			return [
				{
					_tag: "TextPart",
					text:
						`<permission_rejected>\n` +
						`<reason>${message}</reason>\n` +
						`This restriction exists to prevent accidental or catastrophic operations. Do not try to work around it — respect the intent of the restriction rather than finding methods that bypass the check. Provide the command to the user if you need them to run it.\n` +
						`</permission_rejected>`,
				},
			];
		}
		return harnessFormat(entry);
	};
}
