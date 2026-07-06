import { describe, expect, it } from "vitest";
import { classifyCommand } from "../src/core/command-classifier.ts";

describe("command-classifier", () => {
	describe("classifyCommand", () => {
		it("should classify npm run dev as long-running", () => {
			const result = classifyCommand("npm run dev");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("npm run dev");
		});

		it("should classify pnpm dev as long-running", () => {
			const result = classifyCommand("pnpm dev");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("pnpm dev");
		});

		it("should classify yarn run dev as long-running", () => {
			const result = classifyCommand("yarn run dev");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("yarn run dev");
		});

		it("should classify bun dev as long-running", () => {
			const result = classifyCommand("bun dev");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("bun dev");
		});

		it("should classify vite as long-running", () => {
			const result = classifyCommand("vite");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("vite");
		});

		it("should classify next dev as long-running", () => {
			const result = classifyCommand("next dev");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("next dev");
		});

		it("should classify nodemon as long-running", () => {
			const result = classifyCommand("nodemon src/index.ts");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("nodemon");
		});

		it("should classify commands with --watch as long-running", () => {
			const result = classifyCommand("tsc --watch");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("--watch flag");
		});

		it("should classify esbuild --watch as long-running", () => {
			const result = classifyCommand("esbuild src/index.ts --bundle --watch");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("esbuild --watch");
		});

		it("should classify npm run dev with extra args as long-running", () => {
			const result = classifyCommand("npm run dev -- --host 0.0.0.0");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("npm run dev");
		});

		it("should classify turbo dev as long-running", () => {
			const result = classifyCommand("turbo dev");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("turbo dev");
		});

		it("should classify pm2 as long-running", () => {
			const result = classifyCommand("pm2 start app.js");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("pm2");
		});

		it("should classify normal commands as not long-running", () => {
			const result = classifyCommand("ls -la");
			expect(result.longRunning).toBe(false);
			expect(result.reason).toBeUndefined();
		});

		it("should classify git commands as not long-running", () => {
			const result = classifyCommand("git status");
			expect(result.longRunning).toBe(false);
		});

		it("should classify npm test as not long-running", () => {
			const result = classifyCommand("npm test");
			expect(result.longRunning).toBe(false);
		});

		it("should classify npm run build as not long-running", () => {
			const result = classifyCommand("npm run build");
			expect(result.longRunning).toBe(false);
		});

		it("should classify npm run test as not long-running", () => {
			const result = classifyCommand("npm run test");
			expect(result.longRunning).toBe(false);
		});

		it("should classify empty command as not long-running", () => {
			const result = classifyCommand("");
			expect(result.longRunning).toBe(false);
		});

		it("should classify commands with --serve as long-running", () => {
			const result = classifyCommand("python -m http.server --serve");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("--serve flag");
		});

		it("should classify commands with -w flag as long-running", () => {
			const result = classifyCommand("rollup -c -w");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("rollup -w");
		});

		it("should classify webpack serve as long-running", () => {
			const result = classifyCommand("webpack serve");
			expect(result.longRunning).toBe(true);
			expect(result.reason).toBe("webpack serve");
		});
	});
});
