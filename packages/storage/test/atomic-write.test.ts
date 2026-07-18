import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFile, stringifyValidated } from "../src/atomic-write.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "piki-atomic-storage-"));
	tempDirs.push(dir);
	return dir;
}

describe("atomicWriteFile", () => {
	it("writes a valid JSON file via value", async () => {
		const dir = tmp();
		const path = join(dir, "nested", "config.json");
		const value = { a: 1, b: ["x", "y"], c: { d: true } };

		await atomicWriteFile(path, value);

		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(value);
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});

	it("writes a pre-serialized string unchanged", async () => {
		const dir = tmp();
		const path = join(dir, "raw.txt");
		const content = '{"custom":"not validated"}';

		await atomicWriteFile(path, content);

		expect(readFileSync(path, "utf-8")).toBe(content);
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});

	it("creates parent directories", async () => {
		const dir = tmp();
		const path = join(dir, "a", "b", "c", "out.json");
		await atomicWriteFile(path, { ok: true });
		expect(existsSync(path)).toBe(true);
	});
});

describe("stringifyValidated", () => {
	it("round-trips a serializable value", () => {
		const value = { x: 1, y: [2, 3] };
		expect(JSON.parse(stringifyValidated(value))).toEqual(value);
	});

	it("throws on circular references", () => {
		const value: Record<string, unknown> = { a: 1 };
		value.self = value;
		expect(() => stringifyValidated(value)).toThrow();
	});
});
