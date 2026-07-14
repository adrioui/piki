import { Effect, STM, TSemaphore } from "effect";

export type WorkerLifecycleStatus = "created" | "running" | "finished" | "killed" | "error" | "cleaned";

export interface WorkerLifecycleRecord {
	agentId: string;
	forkId: string;
	role: string;
	status: WorkerLifecycleStatus;
	createdAt: number;
	updatedAt: number;
	lastMessageAt?: number;
	cleanupReason?: string;
}

export type WorkerLifecycleAction =
	| { type: "created"; agentId: string; forkId: string; role: string }
	| { type: "started"; agentId: string }
	| { type: "messaged"; agentId: string }
	| { type: "finished"; agentId: string; status: "finished" | "killed" | "error"; reason?: string }
	| { type: "cleaned"; agentId: string; reason: string };

export class WorkerLifecycleRegistry {
	private readonly records = new Map<string, WorkerLifecycleRecord>();
	private readonly forkAgents = new Map<string, Set<string>>();
	private readonly semaphore = Effect.runSync(STM.commit(TSemaphore.make(1)));

	apply(action: WorkerLifecycleAction): Effect.Effect<WorkerLifecycleRecord | undefined> {
		return TSemaphore.withPermit(this.semaphore)(Effect.sync(() => this.applyUnsafe(action)));
	}

	snapshot(): WorkerLifecycleRecord[] {
		return [...this.records.values()].map((record) => ({ ...record }));
	}

	get(agentId: string): WorkerLifecycleRecord | undefined {
		const record = this.records.get(agentId);
		return record ? { ...record } : undefined;
	}

	getByFork(forkId: string): WorkerLifecycleRecord[] {
		const agentIds = this.forkAgents.get(forkId);
		if (!agentIds) return [];
		return [...agentIds]
			.map((agentId) => this.records.get(agentId))
			.filter((record): record is WorkerLifecycleRecord => record !== undefined)
			.map((record) => ({ ...record }));
	}

	private applyUnsafe(action: WorkerLifecycleAction): WorkerLifecycleRecord | undefined {
		const now = Date.now();
		if (action.type === "created") {
			const record: WorkerLifecycleRecord = {
				agentId: action.agentId,
				forkId: action.forkId,
				role: action.role,
				status: "created",
				createdAt: now,
				updatedAt: now,
			};
			this.records.set(action.agentId, record);
			let agents = this.forkAgents.get(action.forkId);
			if (!agents) {
				agents = new Set();
				this.forkAgents.set(action.forkId, agents);
			}
			agents.add(action.agentId);
			return { ...record };
		}

		const record = this.records.get(action.agentId);
		if (!record) return undefined;
		if (action.type === "started") {
			record.status = "running";
		} else if (action.type === "messaged") {
			record.lastMessageAt = now;
		} else if (action.type === "finished") {
			record.status = action.status;
			record.cleanupReason = action.reason;
		} else {
			record.status = "cleaned";
			record.cleanupReason = action.reason;
			this.forkAgents.get(record.forkId)?.delete(action.agentId);
		}
		record.updatedAt = now;
		return { ...record };
	}
}
