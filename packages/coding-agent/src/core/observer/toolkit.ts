import { type TSchema, Type } from "typebox";

export const OBSERVER_JUSTIFICATIONS = ["difficulty", "churn", "frustration"] as const;
export type ObserverJustification = (typeof OBSERVER_JUSTIFICATIONS)[number];

export type ObserverVerdict =
	| { action: "pass"; message: string }
	| { action: "escalate"; justification: ObserverJustification; message: string };

export interface ObserverToolkitTool {
	name: "pass" | "escalate";
	description: string;
	parameters: TSchema;
	execute: (_id: string, args: unknown) => Promise<ObserverToolkitResult>;
}

export interface ObserverToolkitResult {
	content: Array<{ type: "text"; text: string }>;
	details: ObserverVerdict;
}

function parseJustification(value: unknown): ObserverJustification {
	return OBSERVER_JUSTIFICATIONS.includes(value as ObserverJustification)
		? (value as ObserverJustification)
		: "difficulty";
}

function result(verdict: ObserverVerdict): ObserverToolkitResult {
	return {
		content: [{ type: "text", text: JSON.stringify(verdict) }],
		details: verdict,
	};
}

export function createObserverToolkit(): ObserverToolkitTool[] {
	return [
		{
			name: "pass",
			description: "Report that no escalation is needed for the observed turn.",
			parameters: Type.Object({
				message: Type.Optional(Type.String()),
			}),
			execute: async (_id, args) =>
				result({
					action: "pass",
					message:
						typeof (args as Record<string, unknown>)?.message === "string"
							? String((args as Record<string, unknown>).message)
							: "pass",
				}),
		},
		{
			name: "escalate",
			description: "Escalate the observed turn to the advisor.",
			parameters: Type.Object({
				justification: Type.Union([Type.Literal("difficulty"), Type.Literal("churn"), Type.Literal("frustration")]),
				message: Type.Optional(Type.String()),
			}),
			execute: async (_id, args) => {
				const input = (args ?? {}) as Record<string, unknown>;
				const justification = parseJustification(input.justification);
				return result({
					action: "escalate",
					justification,
					message: typeof input.message === "string" ? input.message : justification,
				});
			},
		},
	];
}
