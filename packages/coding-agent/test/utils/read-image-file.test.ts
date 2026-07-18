import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readImageFileForModel } from "../../src/utils/read-image-file.ts";

// A 2x2 PNG that passes detectSupportedImageMimeType's sniffer.
// Minimal header: PNG sig (8) + chunk length=13 (4) + "IHDR" (4) = 16 sniffable bytes.
// The remaining bytes are padding; photon will either resize or return null.
const TINY_PNG = new Uint8Array([
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
	0x0d, // IHDR chunk length = 13
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
	0x02, // bit depth 8, colour type 2 (RGB)
	0x00,
	0x00,
	0x00, // compression, filter, interlace
	0x7f,
	0x8f,
	0xef,
	0x04, // CRC (arbitrary)
	// IDAT + IEND minimal
	0x00,
	0x00,
	0x00,
	0x00,
	0x49,
	0x44,
	0x41,
	0x54,
	0x08,
	0xd7,
	0x63,
	0x60,
	0x00,
	0x00,
	0x00,
	0x02,
	0x00,
	0x01,
	0xe5,
	0x27,
	0xde,
	0x00,
	0x00,
	0x00,
	0x00,
	0x49,
	0x45,
	0x4e,
	0x44,
	0xae,
	0x42,
	0x60,
	0x82,
]);

// Minimal JPEG that passes detectSupportedImageMimeType (starts with FF D8 FF).
const TINY_JPEG = new Uint8Array([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
	0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08,
	0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a,
	0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34,
	0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xd9,
]);

const SVG_CONTENT =
	'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="3"/></svg>';
const SVG_BYTES = new Uint8Array(Buffer.from(SVG_CONTENT, "utf-8"));

describe("readImageFileForModel", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "readimage-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("PNG → base64 + mediaType (resized or passthrough if photon absent)", async () => {
		const path = join(dir, "test.png");
		await writeFile(path, TINY_PNG);
		const out = await readImageFileForModel(path);
		expect(out.base64).toMatch(/^[A-Za-z0-9+/]+=*$/);
		expect(out.mediaType).toMatch(/^image\/(png|jpeg)$/);
		expect(typeof out.width).toBe("number");
		expect(typeof out.height).toBe("number");
		expect(out.width).toBeGreaterThanOrEqual(0);
		expect(out.height).toBeGreaterThanOrEqual(0);
	});

	it("JPEG → base64 + mediaType ∈ {image/jpeg, image/png}", async () => {
		const path = join(dir, "photo.jpg");
		await writeFile(path, TINY_JPEG);
		const out = await readImageFileForModel(path);
		expect(out.base64).toMatch(/^[A-Za-z0-9+/]+=*$/);
		expect(["image/jpeg", "image/png"]).toContain(out.mediaType);
	});

	it("SVG → passthrough with mediaType image/png, width/height 0", async () => {
		const path = join(dir, "drawing.svg");
		await writeFile(path, SVG_BYTES);
		const out = await readImageFileForModel(path);
		expect(out.mediaType).toBe("image/png");
		expect(out.width).toBe(0);
		expect(out.height).toBe(0);
		// Verify the SVG content is actually in the base64
		const decoded = Buffer.from(out.base64, "base64").toString("utf-8");
		expect(decoded).toContain("<svg");
	});

	it("unknown extension + unrecognised bytes → throw", async () => {
		const path = join(dir, "data.bin");
		await writeFile(path, new Uint8Array([0x00, 0x01, 0x02, 0x03]));
		await expect(readImageFileForModel(path)).rejects.toThrow(/Unsupported or unknown image format/);
	});

	it("allowSvgPassthrough:false → SVG detected as image/svg+xml via mime sniff", async () => {
		const path = join(dir, "icon.svg");
		await writeFile(path, SVG_BYTES);
		const out = await readImageFileForModel(path, { allowSvgPassthrough: false });
		expect(out.mediaType).toBe("image/svg+xml");
		expect(out.width).toBe(0);
		expect(out.height).toBe(0);
		const decoded = Buffer.from(out.base64, "base64").toString("utf-8");
		expect(decoded).toContain("<svg");
	});
});
