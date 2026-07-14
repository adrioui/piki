import { Schema } from "effect";

/** Task status values. Only pending/completed/cancelled are supported (no "working"). */
export const UpdateTaskStatusSchema = Schema.Literal("pending", "completed", "cancelled");

export type UpdateTaskStatus = Schema.Schema.Type<typeof UpdateTaskStatusSchema>;

/** Justification values for pass/escalate tools. L83943. */
export const JUSTIFICATION_VALUES = ["difficulty", "churn", "frustration"] as const;

export const JustificationSchema = Schema.Literal(...JUSTIFICATION_VALUES);

export type Justification = Schema.Schema.Type<typeof JustificationSchema>;
