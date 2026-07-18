import { Schema } from "effect";

/** Task status values. Only pending/completed/cancelled are supported (no "working"). */
export const UpdateTaskStatusSchema = Schema.Literal("pending", "completed", "cancelled");

export type UpdateTaskStatus = Schema.Schema.Type<typeof UpdateTaskStatusSchema>;
