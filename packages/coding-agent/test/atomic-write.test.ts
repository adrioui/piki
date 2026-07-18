import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteSync, stringifyValidated } from "../src/utils/atomic-write.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "piki-atomic-"));
	tempDirs.push(dir);
	return dir;
}

describe("atomicWriteSync", () => {
	it("writes content to the target path", () => {
		const dir = tmp();
		const path = join(dir, "nested", "meta.json");
		const content = JSON.stringify({ hello: "world" }, null, 2);

		atomicWriteSync(path, content);

		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf-8")).toBe(content);
	});

	it("leaves no .tmp leftover on success", () => {
		const dir = tmp();
		const path = join(dir, "out.txt");
		atomicWriteSync(path, "payload");

		expect(existsSync(`${path}.tmp`)).toBe(false);
	});

	it("creates parent directories", () => {
		const dir = tmp();
		const path = join(dir, "a", "b", "c", "file.json");
		atomicWriteSync(path, "{}");
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
