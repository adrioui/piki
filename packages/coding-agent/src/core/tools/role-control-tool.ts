import type { AgentToolResult } from "@piki/agent-core";
import { Type } from "typebox";
import { defineTool, type ExtensionContext, type ToolDefinition } from "../extensions/types.ts";
import type { ForkRuntime } from "../fork-runtime.ts";

/**
 * Registry mapping session IDs to ForkRuntime instances.
 * Tools look up the runtime by session ID from the ExtensionContext.
 */
const RUNTIME_REGISTRY = new Map<string, ForkRuntime>();

export function registerForkRuntime(sessionId: string, runtime: ForkRuntime): void {
	RUNTIME_REGISTRY.set(sessionId, runtime);
}

export function unregisterForkRuntime(sessionId: string): void {
	RUNTIME_REGISTRY.delete(sessionId);
}

function getRuntime(ctx: ExtensionContext): ForkRuntime | undefined {
	const sessionId = ctx.sessionManager.getSessionId();
	return RUNTIME_REGISTRY.get(sessionId);
}

function success(message: string, data?: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: data ?? null };
}

function errorResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: { error: true, message } };
}

type RoleToolHandler = (runtime: ForkRuntime, params: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;

const TOOL_HANDLERS: Record<string, RoleToolHandler> = {
	spawnWorker: async (rt, p) => {
		const result = await rt.spawnWorker({
			role: String(p.role ?? ""),
			message: p.message as string | undefined,
			taskId: p.taskId as string | undefined,
			context: p.context as string | undefined,
		});
		return success(`Spawned worker ${result.agentId} (fork ${result.forkId})`, {
			...result,
			workerId: result.agentId,
		});
	},
	messageWorker: async (rt, p) => {
		await rt.messageWorker({ workerId: String(p.workerId ?? ""), message: String(p.message ?? "") });
		return success(`Messaged worker ${p.workerId}`);
	},
	killWorker: async (rt, p) => {
		await rt.killWorker({ workerId: String(p.workerId ?? ""), reason: p.reason as string | undefined });
		return success(`Killed worker ${p.workerId}`);
	},
	createTask: async (rt, p) => {
		const result = await rt.createTask({
			title: String(p.title ?? p.message ?? ""),
			description: p.description as string | undefined,
			parentId: p.parentId as string | undefined,
			assignee: p.assignee as string | undefined,
		});
		return success(`Created task ${result.taskId}`, result);
	},
	updateTask: async (rt, p) => {
		await rt.updateTask({
			taskId: String(p.taskId ?? ""),
			status: p.status as "pending" | "working" | "completed" | "cancelled",
		});
		return success(`Updated task ${p.taskId}`);
	},
	finishGoal: async (rt, p) => {
		await rt.finishGoal({ goalText: p.goalText as string | undefined, evidence: p.evidence as string | undefined });
		return success("Goal completion requested. Verification in progress — you will be notified of the result.");
	},
	pass: async (rt, p) => {
		await rt.pass({ message: p.message as string | undefined });
		return success("Turn passed");
	},
	escalate: async (rt, p) => {
		await rt.escalate({ justification: String(p.justification ?? ""), message: p.message as string | undefined });
		return success("Escalation requested");
	},
	reassignWorker: async (rt, p) => {
		await rt.reassignWorker({ taskId: String(p.taskId ?? ""), workerId: String(p.workerId ?? "") });
		return success(`Reassigned task ${p.taskId} to ${p.workerId}`);
	},
	messageAdvisor: async (rt, p) => {
		await rt.messageAdvisor({ message: String(p.message ?? "") });
		return success("Message sent to advisor");
	},
};

const TOOL_SCHEMAS: Record<string, ReturnType<typeof Type.Object>> = {
	spawnWorker: Type.Object({
		role: Type.Union(
			[
				Type.Literal("scout"),
				Type.Literal("architect"),
				Type.Literal("engineer"),
				Type.Literal("critic"),
				Type.Literal("scientist"),
				Type.Literal("artisan"),
			],
			{ description: "Role to spawn" },
		),
		message: Type.Optional(Type.String({ description: "Initial message/task for the worker" })),
		taskId: Type.Optional(Type.String({ description: "Task ID to assign to the worker" })),
		context: Type.Optional(Type.String({ description: "Additional context for the worker" })),
	}),
	messageWorker: Type.Object({
		workerId: Type.String({ description: "ID of the worker to message" }),
		message: Type.String({ description: "Message to send to the worker" }),
	}),
	killWorker: Type.Object({
		workerId: Type.String({ description: "ID of the worker to kill" }),
		reason: Type.Optional(Type.String({ description: "Reason for killing the worker" })),
	}),
	createTask: Type.Object({
		title: Type.String({ description: "Task title" }),
		description: Type.Optional(Type.String({ description: "Task description or context" })),
		parentId: Type.Optional(Type.String({ description: "Parent task ID for subtasks" })),
		assignee: Type.Optional(Type.String({ description: "Worker ID to assign the task to" })),
	}),
	updateTask: Type.Object({
		taskId: Type.String({ description: "Task ID to update" }),
		status: Type.Union(
			[Type.Literal("pending"), Type.Literal("working"), Type.Literal("completed"), Type.Literal("cancelled")],
			{ description: "New task status" },
		),
	}),
	finishGoal: Type.Object({
		goalText: Type.Optional(Type.String({ description: "The goal that was finished" })),
		evidence: Type.Optional(Type.String({ description: "Evidence that the goal was achieved" })),
	}),
	pass: Type.Object({
		message: Type.Optional(Type.String({ description: "Reason for passing" })),
	}),
	escalate: Type.Object({
		justification: Type.String({ description: "Why escalation is needed" }),
		message: Type.Optional(Type.String({ description: "Additional context for the escalation" })),
	}),
	reassignWorker: Type.Object({
		taskId: Type.String({ description: "Task ID to reassign" }),
		workerId: Type.String({ description: "Worker ID to assign the task to" }),
	}),
	messageAdvisor: Type.Object({
		message: Type.String({ description: "Message to send to the advisor" }),
	}),
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
	spawnWorker: "Spawn an event-core worker agent with a specific role.",
	messageWorker: "Send a message to a running worker agent.",
	killWorker: "Kill a running worker agent.",
	createTask: "Create a new task in the task graph.",
	updateTask: "Update a task's status in the task graph.",
	finishGoal: "Mark the current goal as finished with evidence.",
	pass: "Pass the current turn without taking action.",
	escalate: "Escalate to the observer/advisor for help.",
	reassignWorker: "Reassign a task to a different worker.",
	messageAdvisor: "Send a message to the advisor role.",
};

/**
 * Create a role control tool definition with per-tool schema and fork-runtime wiring.
 */
export function createRoleControlTool(name: string, description: string): ToolDefinition {
	return defineTool({
		name,
		label: name,
		description: description || TOOL_DESCRIPTIONS[name] || description,
		parameters: TOOL_SCHEMAS[name] ?? Type.Object({}),
		hidden: true,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> => {
			const handler = TOOL_HANDLERS[name];
			if (!handler) {
				return errorResult(`Unknown role control tool: ${name}`);
			}
			try {
				const runtime = getRuntime(ctx);
				if (!runtime) {
					return errorResult("Multi-agent runtime not registered. Role control tools are unavailable.");
				}
				return await handler(runtime, params as Record<string, unknown>);
			} catch (err) {
				return errorResult(err instanceof Error ? err.message : String(err));
			}
		},
	});
}
