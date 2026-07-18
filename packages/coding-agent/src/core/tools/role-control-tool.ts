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
	spawn_worker: async (rt, p) => {
		const result = await rt.spawnWorker({
			role: String(p.role ?? ""),
			message: p.message as string | undefined,
			taskId: p.taskId as string | undefined,
			agentId: p.agentId as string | undefined,
			yield: p.yield as boolean | undefined,
		});
		return success(`Spawned worker ${result.agentId} (fork ${result.forkId})`, {
			...result,
			workerId: result.agentId,
		});
	},
	message_worker: async (rt, p) => {
		await rt.messageWorker({
			workerId: String(p.agentId ?? ""),
			message: String(p.message ?? ""),
			yield: p.yield as boolean | undefined,
		});
		return success(`Messaged worker ${p.agentId}`);
	},
	kill_worker: async (rt, p) => {
		const workerId = rt.workerIdForTask(String(p.taskId ?? ""));
		if (!workerId) {
			return errorResult(`No worker found for task ${p.taskId}`);
		}
		await rt.killWorker({ workerId, reason: p.reason as string | undefined });
		return success(`Killed worker for task ${p.taskId} (${workerId})`);
	},
	create_task: async (rt, p) => {
		const result = await rt.createTask({
			taskId: String(p.taskId ?? ""),
			title: String(p.title ?? p.message ?? ""),
			parentId: p.parent as string | undefined,
			after: p.after as string | undefined,
		});
		return success(`Created task ${result.taskId}`, result);
	},
	update_task: async (rt, p) => {
		await rt.updateTask({
			taskId: String(p.taskId ?? ""),
			status: p.status as "pending" | "completed" | "cancelled",
		});
		return success(`Updated task ${p.taskId}`);
	},
	finish_goal: async (rt, p) => {
		await rt.finishGoal({ evidence: p.evidence as string | undefined });
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
	reassign_worker: async (rt, p) => {
		await rt.reassignWorker({ taskId: String(p.taskId ?? ""), workerId: String(p.agentId ?? "") });
		return success(`Reassigned task ${p.taskId} to ${p.agentId}`);
	},
	message_advisor: async (rt, p) => {
		await rt.messageAdvisor({ message: String(p.message ?? "") });
		return success("Message sent to advisor");
	},
};

const TOOL_SCHEMAS: Record<string, ReturnType<typeof Type.Object>> = {
	spawn_worker: Type.Object({
		role: Type.String({
			description: "Worker role (e.g., engineer, scout, architect, critic, scientist, artisan).",
		}),
		message: Type.String({ description: "Initial message/task for the worker" }),
		taskId: Type.String({
			description: "Task ID to assign to the worker (the runtime associates the worker with this task).",
		}),
		agentId: Type.String({
			description: "Unique agent ID for the worker",
		}),
		yield: Type.Optional(
			Type.Boolean({ description: "Set true to yield the leader turn to this worker before continuing" }),
		),
	}),
	message_worker: Type.Object({
		agentId: Type.String({ description: "ID of the worker to message" }),
		message: Type.String({ description: "Message to send to the worker" }),
		yield: Type.Optional(
			Type.Boolean({ description: "When true, yield to this worker — the leader turn will not retrigger." }),
		),
	}),
	kill_worker: Type.Object({
		taskId: Type.String({ description: "Task ID whose worker to kill" }),
		reason: Type.Optional(Type.String({ description: "Reason for killing the worker" })),
	}),
	create_task: Type.Object({
		taskId: Type.String({ description: "Task ID to assign to the created task" }),
		title: Type.String({ description: "Task title" }),
		parent: Type.Optional(Type.String({ description: "Parent task ID for subtasks" })),
		after: Type.Optional(Type.String({ description: "Task ID this task depends on (run after)" })),
	}),
	update_task: Type.Object({
		taskId: Type.String({ description: "Task ID to update" }),
		status: Type.Union([Type.Literal("pending"), Type.Literal("completed"), Type.Literal("cancelled")], {
			description: "New task status",
		}),
	}),
	finish_goal: Type.Object({
		evidence: Type.String({ description: "Evidence that the goal was achieved" }),
	}),
	pass: Type.Object({
		message: Type.Optional(Type.String({ description: "Reason for passing" })),
	}),
	escalate: Type.Object({
		justification: Type.String({ description: "Why escalation is needed" }),
		message: Type.Optional(Type.String({ description: "Additional context for the escalation" })),
	}),
	reassign_worker: Type.Object({
		taskId: Type.String({ description: "Task ID to reassign" }),
		agentId: Type.String({ description: "Agent ID to assign the task to" }),
	}),
	message_advisor: Type.Object({
		message: Type.String({ description: "Message to send to the advisor" }),
	}),
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
	spawn_worker: "Spawn an event-core worker agent with a specific role.",
	message_worker: "Send a message to a running worker agent.",
	kill_worker: "Kill a running worker agent.",
	create_task: "Create a new task in the task graph.",
	update_task: "Update a task's status in the task graph.",
	finish_goal: "Mark the current goal as finished with evidence.",
	pass: "Pass the current turn without taking action.",
	escalate: "Escalate to the observer/advisor for help.",
	reassign_worker: "Reassign a task to a different worker.",
	message_advisor: "Send a message to the advisor role.",
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
