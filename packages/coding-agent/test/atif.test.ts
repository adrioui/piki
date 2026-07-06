import { describe, expect, it } from "vitest";
import {
	buildAtifMetadata,
	detectAtifVersion,
	entriesToSteps,
	exportAtifLegacy,
	exportAtifV17,
	extractEntriesFromAtif,
	extractHeaderFromAtif,
} from "../src/core/atif.ts";
import type { SessionEntry, SessionHeader } from "../src/core/session-manager.ts";

const mockHeader: SessionHeader = {
	type: "session",
	version: 3,
	id: "test-session-001",
	timestamp: "2026-07-04T10:00:00.000Z",
	cwd: "/home/user/project",
};

const mockEntries: SessionEntry[] = [
	{
		type: "message",
		id: "msg-001",
		parentId: null,
		timestamp: "2026-07-04T10:00:01.000Z",
		message: {
			role: "user",
			content: "Fix the login bug",
			timestamp: Date.now(),
		},
	},
	{
		type: "message",
		id: "msg-002",
		parentId: "msg-001",
		timestamp: "2026-07-04T10:00:05.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "I'll help you fix the login bug." }],
			model: "deepseek-v4-pro",
			provider: "commandcode",
			stopReason: "stop",
			api: "commandcode",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		},
	},
	{
		type: "model_change",
		id: "mc-001",
		parentId: "msg-002",
		timestamp: "2026-07-04T10:00:06.000Z",
		provider: "openai",
		modelId: "gpt-4o",
	},
	{
		type: "compaction",
		id: "comp-001",
		parentId: "mc-001",
		timestamp: "2026-07-04T10:01:00.000Z",
		summary: "User asked to fix login bug.",
		firstKeptEntryId: "msg-002",
		tokensBefore: 5000,
	},
	{
		type: "session_info",
		id: "si-001",
		parentId: "comp-001",
		timestamp: "2026-07-04T10:02:00.000Z",
		name: "Fix Login Bug",
	},
	{
		type: "label",
		id: "lbl-001",
		parentId: "si-001",
		timestamp: "2026-07-04T10:03:00.000Z",
		targetId: "msg-002",
		label: "first-response",
	},
];

describe("atif", () => {
	describe("entriesToSteps", () => {
		it("should convert message entries to steps", () => {
			const steps = entriesToSteps([mockEntries[0]!, mockEntries[1]!]);
			expect(steps).toHaveLength(2);
			expect(steps[0]!.type).toBe("message");
			expect(steps[0]!.role).toBe("user");
			expect(steps[0]!.content).toEqual([{ type: "text", text: "Fix the login bug" }]);
			expect(steps[1]!.role).toBe("assistant");
		});

		it("should convert compaction entries to steps with metadata", () => {
			const steps = entriesToSteps([mockEntries[3]!]);
			expect(steps[0]!.type).toBe("compaction");
			expect(steps[0]!.metadata).toEqual({
				summary: "User asked to fix login bug.",
				firstKeptEntryId: "msg-002",
				tokensBefore: 5000,
				fromHook: undefined,
			});
		});

		it("should convert model_change entries to steps with metadata", () => {
			const steps = entriesToSteps([mockEntries[2]!]);
			expect(steps[0]!.type).toBe("model_change");
			expect(steps[0]!.metadata).toEqual({
				provider: "openai",
				modelId: "gpt-4o",
			});
		});

		it("should convert session_info entries to steps with metadata", () => {
			const steps = entriesToSteps([mockEntries[4]!]);
			expect(steps[0]!.type).toBe("session_info");
			expect(steps[0]!.metadata).toEqual({ name: "Fix Login Bug" });
		});

		it("should convert label entries to steps with metadata", () => {
			const steps = entriesToSteps([mockEntries[5]!]);
			expect(steps[0]!.type).toBe("label");
			expect(steps[0]!.metadata).toEqual({
				targetId: "msg-002",
				label: "first-response",
			});
		});

		it("should preserve parent chain", () => {
			const steps = entriesToSteps(mockEntries);
			expect(steps[0]!.parentId).toBeNull();
			expect(steps[1]!.parentId).toBe("msg-001");
			expect(steps[2]!.parentId).toBe("msg-002");
		});

		it("should handle empty entries", () => {
			expect(entriesToSteps([])).toEqual([]);
		});
	});

	describe("buildAtifMetadata", () => {
		it("should build metadata from header and entries", () => {
			const meta = buildAtifMetadata(mockHeader, mockEntries);
			expect(meta.format).toBe("atif");
			expect(meta.version).toBe(1.7);
			expect(meta.createdAt).toBe("2026-07-04T10:00:00.000Z");
			expect(meta.agent).toBe("piki");
			expect(meta.cwd).toBe("/home/user/project");
			expect(meta.sessionId).toBe("test-session-001");
			expect(meta.messageCount).toBe(2);
			expect(meta.model).toBe("gpt-4o");
			expect(meta.provider).toBe("openai");
		});

		it("should extract session name from entries", () => {
			const meta = buildAtifMetadata(mockHeader, mockEntries);
			expect(meta.sessionName).toBe("Fix Login Bug");
		});

		it("should handle null header", () => {
			const meta = buildAtifMetadata(null, []);
			expect(meta.createdAt).toBeDefined();
			expect(meta.sessionId).toBeUndefined();
		});
	});

	describe("exportAtifV17", () => {
		it("should produce v1.7 trajectory", () => {
			const trajectory = exportAtifV17(mockHeader, mockEntries);
			expect(trajectory.format).toBe("atif");
			expect(trajectory.version).toBe(1.7);
			expect(trajectory.metadata).toBeDefined();
			expect(trajectory.steps).toBeDefined();
			expect(trajectory.vendor?.piki?.sessionHeader).toBe(mockHeader);
			expect(trajectory.vendor?.piki?.entries).toBe(mockEntries);
		});

		it("should have steps from entries", () => {
			const trajectory = exportAtifV17(mockHeader, mockEntries);
			expect(trajectory.steps.length).toBe(mockEntries.length);
		});
	});

	describe("exportAtifLegacy", () => {
		it("should produce v1 trajectory", () => {
			const trajectory = exportAtifLegacy(mockHeader, mockEntries);
			expect(trajectory.format).toBe("atif");
			expect(trajectory.version).toBe(1);
			expect(trajectory.session).toBe(mockHeader);
			expect(trajectory.entries).toBe(mockEntries);
		});
	});

	describe("detectAtifVersion", () => {
		it("should detect v1", () => {
			expect(detectAtifVersion({ format: "atif", version: 1 })).toBe(1);
		});

		it("should detect v1.7", () => {
			expect(detectAtifVersion({ format: "atif", version: 1.7 })).toBe(1.7);
		});

		it("should return null for non-ATIF", () => {
			expect(detectAtifVersion({ format: "json", version: 1 })).toBeNull();
		});

		it("should return null for null input", () => {
			expect(detectAtifVersion(null)).toBeNull();
		});

		it("should return null for non-object", () => {
			expect(detectAtifVersion("string")).toBeNull();
		});
	});

	describe("extractEntriesFromAtif", () => {
		it("should extract from legacy v1", () => {
			const data = exportAtifLegacy(mockHeader, mockEntries);
			expect(extractEntriesFromAtif(data)).toBe(mockEntries);
		});

		it("should extract from v1.7", () => {
			const data = exportAtifV17(mockHeader, mockEntries);
			expect(extractEntriesFromAtif(data)).toBe(mockEntries);
		});

		it("should return null for invalid data", () => {
			expect(extractEntriesFromAtif(null)).toBeNull();
			expect(extractEntriesFromAtif({ format: "json" })).toBeNull();
		});
	});

	describe("extractHeaderFromAtif", () => {
		it("should extract from legacy v1", () => {
			const data = exportAtifLegacy(mockHeader, mockEntries);
			expect(extractHeaderFromAtif(data)).toBe(mockHeader);
		});

		it("should extract from v1.7", () => {
			const data = exportAtifV17(mockHeader, mockEntries);
			expect(extractHeaderFromAtif(data)).toBe(mockHeader);
		});

		it("should return null for invalid data", () => {
			expect(extractHeaderFromAtif(null)).toBeNull();
		});
	});

	describe("roundtrip compatibility", () => {
		it("v1.7 should preserve all entries through extraction", () => {
			const trajectory = exportAtifV17(mockHeader, mockEntries);
			const extractedEntries = extractEntriesFromAtif(trajectory);
			expect(extractedEntries).toHaveLength(mockEntries.length);
			expect(extractedEntries![0]!.id).toBe("msg-001");
			expect(extractedEntries![1]!.id).toBe("msg-002");
		});

		it("legacy v1 should preserve all entries through extraction", () => {
			const trajectory = exportAtifLegacy(mockHeader, mockEntries);
			const extractedEntries = extractEntriesFromAtif(trajectory);
			expect(extractedEntries).toHaveLength(mockEntries.length);
		});
	});
});
