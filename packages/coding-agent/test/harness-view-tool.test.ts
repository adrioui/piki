import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ToolImageSchema } from "../src/core/harness/tool-image.ts";
import {
	createViewAgentTool,
	defineViewHarnessTool,
	FsErrorSchema,
	ViewOutputSchema,
} from "../src/core/harness/tools/view.ts";

// ---------------------------------------------------------------------------
// Minimal binary image fixtures (valid headers for dimension parsing)
// ---------------------------------------------------------------------------

/** Minimal 2x2 PNG (67 bytes). */
function minimalPng(): Buffer {
	const bytes = [
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a, // PNG signature
		0x00,
		0x00,
		0x00,
		0x0d, // IHDR length
		0x49,
		0x48,
		0x44,
		0x52, // "IHDR"
		0x00,
		0x00,
		0x00,
		0x02, // width = 2
		0x00,
		0x00,
		0x00,
		0x02, // height = 2
		0x08,
		0x02,
		0x00,
		0x00,
		0x00, // bit depth 8, color type 2 (RGB)
		0x00,
		0x00,
		0x00,
		0x00, // CRC (dummy — not validated for our purpose)
		// IDAT (minimal deflate stream for 2x2 RGB)
		0x00,
		0x00,
		0x00,
		0x0e, // IDAT length
		0x49,
		0x44,
		0x41,
		0x54, // "IDAT"
		0x08,
		0xd7,
		0x63,
		0xf8,
		0xff,
		0xff,
		0x3f,
		0x00,
		0x05,
		0xfe,
		0x02,
		0xfe,
		0xdc,
		0xcc,
		0x59,
		0x59,
		0x59,
		0x59, // CRC (dummy)
		// IEND
		0x00,
		0x00,
		0x00,
		0x00, // IEND length
		0x49,
		0x45,
		0x4e,
		0x44, // "IEND"
		0xae,
		0x42,
		0x60,
		0x82, // IEND CRC
	];
	return Buffer.from(bytes);
}

/** Minimal 3x3 GIF (35 bytes). */
function minimalGif(): Buffer {
	const bytes = [
		0x47,
		0x49,
		0x46,
		0x38,
		0x39,
		0x61, // "GIF89a"
		0x03,
		0x00, // width = 3 (little-endian)
		0x03,
		0x00, // height = 3 (little-endian)
		0x80,
		0x00,
		0x00, // GCT flag, 2 colors
		0x00,
		0x00,
		0x00, // color 0 (black)
		0xff,
		0xff,
		0xff, // color 1 (white)
		0x21,
		0xf9,
		0x04,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00, // GCE
		0x2c,
		0x00,
		0x00,
		0x00,
		0x00,
		0x03,
		0x00,
		0x03,
		0x00,
		0x00, // Image descriptor
		0x02,
		0x02,
		0x44,
		0x01,
		0x00, // Image data
		0x3b, // Trailer
	];
	return Buffer.from(bytes);
}

/** Minimal 2x2 JPEG (enough for dimension parsing via SOF0 marker). */
function minimalJpeg(): Buffer {
	// SOI + APP0 + SOF0 + SOS + EOI
	// SOF0: precision=8, height=2, width=2, 3 components
	const bytes = [
		0xff,
		0xd8, // SOI
		0xff,
		0xe0,
		0x00,
		0x10,
		0x4a,
		0x46,
		0x49,
		0x46,
		0x00,
		0x01,
		0x01,
		0x00,
		0x00,
		0x01,
		0x00,
		0x00,
		0x01,
		0x00,
		0x00, // APP0
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08, // SOF0, length=17, precision=8
		0x00,
		0x02, // height = 2 (big-endian)
		0x00,
		0x02, // width = 2 (big-endian)
		0x03, // 3 components
		0x01,
		0x11,
		0x00, // Y
		0x02,
		0x11,
		0x00, // Cb
		0x03,
		0x11,
		0x00, // Cr
		0xff,
		0xda,
		0x00,
		0x0c,
		0x03,
		0x01,
		0x00,
		0x02,
		0x11,
		0x03,
		0x11,
		0x00,
		0x3f,
		0x00, // SOS
		0x00, // dummy scan data
		0xff,
		0xd9, // EOI
	];
	return Buffer.from(bytes);
}

/** Minimal 2x2 WebP (VP8 lossy). */
function minimalWebp(): Buffer {
	// RIFF header + WEBP + VP8 chunk with dimensions at bytes 26-29
	const riffPayload = Buffer.alloc(30, 0);
	riffPayload.write("RIFF", 0, "ascii");
	riffPayload.write("WEBP", 8, "ascii");
	riffPayload.write("VP8 ", 12, "ascii");
	// VP8 frame header: at byte 20 starts the frame tag
	// bytes 26-27 = width (little-endian, 14-bit), bytes 28-29 = height
	riffPayload.writeUInt16LE(2, 26); // width = 2
	riffPayload.writeUInt16LE(2, 28); // height = 2
	// Set RIFF file size at bytes 4-7
	riffPayload.writeUInt32LE(riffPayload.length - 8, 4);
	// Set VP8 chunk size at bytes 16-19
	riffPayload.writeUInt32LE(riffPayload.length - 20, 16);
	return riffPayload;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("view harness tool — parity", () => {
	let tempDir: string;
	let scratchpadDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "piki-view-test-"));
		scratchpadDir = mkdtempSync(join(tmpdir(), "piki-view-scratch-"));
		// Write image fixtures
		writeFileSync(join(tempDir, "test.png"), minimalPng());
		writeFileSync(join(tempDir, "test.gif"), minimalGif());
		writeFileSync(join(tempDir, "test.jpg"), minimalJpeg());
		writeFileSync(join(tempDir, "test.webp"), minimalWebp());
		// Write a non-image file
		writeFileSync(join(tempDir, "notimage.txt"), "hello world", "utf-8");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(scratchpadDir, { recursive: true, force: true });
	});

	test("reads a PNG file and returns ToolImage with correct shape", async () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "test.png" }));
		expect(result).toBeDefined();
		expect(typeof result.base64).toBe("string");
		expect(result.base64.length).toBeGreaterThan(0);
		expect(result.mediaType).toBe("image/png");
		expect(result.width).toBe(2);
		expect(result.height).toBe(2);
	});

	test("mediaType detection correct for JPEG", async () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "test.jpg" }));
		expect(result.mediaType).toBe("image/jpeg");
		expect(result.width).toBe(2);
		expect(result.height).toBe(2);
	});

	test("mediaType detection correct for GIF", async () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "test.gif" }));
		expect(result.mediaType).toBe("image/gif");
		expect(result.width).toBe(3);
		expect(result.height).toBe(3);
	});

	test("mediaType detection correct for WebP", async () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "test.webp" }));
		expect(result.mediaType).toBe("image/webp");
		expect(result.width).toBe(2);
		expect(result.height).toBe(2);
	});

	test("fails with FsError on missing file", async () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		try {
			await Effect.runPromise(tool.execute({ path: "nonexistent.png" }));
			expect.fail("should have thrown");
		} catch (err: any) {
			expect(err._tag).toBe("FsError");
			expect(err.message).toBe("Failed to read image: nonexistent.png");
		}
	});

	test("fails with FsError on non-image file", async () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		try {
			await Effect.runPromise(tool.execute({ path: "notimage.txt" }));
			expect.fail("should have thrown");
		} catch (err: any) {
			expect(err._tag).toBe("FsError");
			expect(err.message).toBe("Failed to read image: notimage.txt");
		}
	});

	test("$M/ prefix expands to scratchpadPath", async () => {
		// Write a PNG in the scratchpad dir
		writeFileSync(join(scratchpadDir, "scratch.png"), minimalPng());
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		const result = await Effect.runPromise(tool.execute({ path: "$M/scratch.png" }));
		expect(result.mediaType).toBe("image/png");
		expect(result.width).toBe(2);
		expect(result.height).toBe(2);
	});

	test("stream.onInput throws StreamValidationError for missing file", () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		expect(() => {
			tool.stream?.onInput?.({ path: "does-not-exist.png" });
		}).toThrow();
	});

	test("stream.onInput does not throw for existing file", () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		expect(() => {
			tool.stream?.onInput?.({ path: "test.png" });
		}).not.toThrow();
	});

	test("outputSchema is ToolImageSchema", () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		expect(tool.definition.outputSchema).toBe(ToolImageSchema);
	});

	test("HarnessTool definition has name 'view'", () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		expect(tool.definition.name).toBe("view");
	});

	test("HarnessTool has errorSchema with _tag FsError", () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		expect(tool.errorSchema).toBeDefined();
		expect(tool.errorSchema).toBe(FsErrorSchema);
	});

	test("HarnessTool has a stream handler", () => {
		const tool = defineViewHarnessTool(tempDir, scratchpadDir);
		expect(tool.stream).toBeDefined();
		expect(typeof tool.stream?.onInput).toBe("function");
	});

	test("createViewAgentTool produces a working AgentTool", async () => {
		const harnessTool = defineViewHarnessTool(tempDir, scratchpadDir);
		const agentTool = createViewAgentTool(harnessTool);
		expect(agentTool.name).toBe("view");
		expect(agentTool.parameters).toBeDefined();

		const result = await agentTool.execute("test-id", { path: "test.png" }, undefined, undefined);
		expect(result.content.length).toBeGreaterThanOrEqual(1);
		expect(result.content[0].type).toBe("text");
		// details should be the ToolImage object
		expect((result.details as any).mediaType).toBe("image/png");
		expect((result.details as any).width).toBe(2);
	});

	test("ViewOutputSchema equals ToolImageSchema", () => {
		expect(ViewOutputSchema).toBe(ToolImageSchema);
	});
});
