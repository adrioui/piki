import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getInstancesPath, getMachinePath, getOrchestratorDir } from "./config.ts";
import type { InstanceRecord, MachineRecord } from "./types.ts";

function ensureOrchestratorDir(): void {
	const orchestratorDir = getOrchestratorDir();
	if (!existsSync(orchestratorDir)) {
		mkdirSync(orchestratorDir, { recursive: true });
	}
}

/**
 * Read and parse a JSON file, guarding against corruption.
 *
 * On parse failure the corrupt file is backed up to `<name>.corrupt-<timestamp>`
 * (so the bad data is preserved for inspection) and `undefined` is returned,
 * allowing the caller to fall back to an empty/default state instead of crashing.
 */
function readJsonFileSafe<T>(path: string): T | undefined {
	const data = readFileSync(path, "utf-8");
	try {
		return JSON.parse(data) as T;
	} catch (err) {
		backUpCorruptFile(path);
		console.warn(
			`[orchestrator] Failed to parse ${path}, using default state. Corrupt file backed up. (${
				err instanceof Error ? err.message : String(err)
			})`,
		);
		return undefined;
	}
}

function backUpCorruptFile(path: string): void {
	try {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		copyFileSync(path, `${path}.corrupt-${stamp}`);
	} catch {
		// If the backup itself fails there's nothing actionable; swallow it.
	}
}

export function loadMachine(): MachineRecord | undefined {
	const machinePath = getMachinePath();
	if (!existsSync(machinePath)) {
		return undefined;
	}

	return readJsonFileSafe<MachineRecord>(machinePath);
}

export function saveMachine(machine: MachineRecord): void {
	ensureOrchestratorDir();
	writeFileSync(getMachinePath(), JSON.stringify(machine, null, 2));
}

export function deleteMachine(): void {
	const machinePath = getMachinePath();
	if (!existsSync(machinePath)) {
		return;
	}
	rmSync(machinePath);
}

export function loadInstances(): InstanceRecord[] {
	const instancesPath = getInstancesPath();
	if (!existsSync(instancesPath)) {
		return [];
	}

	return readJsonFileSafe<InstanceRecord[]>(instancesPath) ?? [];
}

export function saveInstances(instances: InstanceRecord[]): void {
	ensureOrchestratorDir();
	writeFileSync(getInstancesPath(), JSON.stringify(instances, null, 2));
}

export function getInstance(instanceId: string): InstanceRecord | undefined {
	return loadInstances().find((instance) => instance.id === instanceId);
}

export function upsertInstance(instance: InstanceRecord): void {
	const instances = loadInstances();
	const index = instances.findIndex((existing) => existing.id === instance.id);
	if (index === -1) {
		instances.push(instance);
		saveInstances(instances);
		return;
	}

	instances[index] = instance;
	saveInstances(instances);
}

export function removeInstance(instanceId: string): void {
	const instances = loadInstances().filter((instance) => instance.id !== instanceId);
	saveInstances(instances);
}
