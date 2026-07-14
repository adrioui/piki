import { spawn } from "node:child_process";
import { access, constants, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getTarget, getVersion } from "./platform.ts";

const REPO = "microsoft/ripgrep-prebuilt";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			const response = await fetch(url, init);
			if (!response.ok) throw new Error(`[ripgrep] HTTP ${response.status} for ${url}`);
			return response;
		} catch (error) {
			lastError = error;
			if (i < attempts - 1) await sleep(2 ** i * 1000);
		}
	}
	throw new Error(
		`[ripgrep] Download failed after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function downloadRg(destDir: string, targetOverride?: string): Promise<string> {
	await mkdir(destDir, { recursive: true });
	const target = targetOverride ?? getTarget();
	const version = getVersion(target);
	const isWin = target.includes("windows");
	const ext = isWin ? ".zip" : ".tar.gz";
	const assetName = `ripgrep-${version}-${target}${ext}`;
	const binName = isWin ? "rg.exe" : "rg";
	const binPath = join(destDir, binName);
	const token = process.env.GITHUB_TOKEN;
	const directUrl = `https://github.com/${REPO}/releases/download/${version}/${assetName}`;
	const dlHeaders: Record<string, string> = { Accept: "application/octet-stream" };
	if (token) dlHeaders.Authorization = `token ${token}`;
	const dlRes = await fetchWithRetry(directUrl, { headers: dlHeaders });
	const bytes = new Uint8Array(await dlRes.arrayBuffer());
	const tmpFile = join(destDir, `${assetName}.tmp`);
	try {
		await writeFile(tmpFile, bytes);
		const tarArgs = isWin ? ["-xf", tmpFile, "-C", destDir] : ["-xzf", tmpFile, "-C", destDir];
		await new Promise<void>((resolve, reject) => {
			const proc = spawn("tar", tarArgs, { stdio: ["ignore", "ignore", "pipe"] });
			proc.on("exit", (code) => {
				if (code !== 0) {
					if (proc.stderr) {
						let stderr = "";
						proc.stderr.setEncoding("utf-8");
						proc.stderr.on("data", (chunk: string) => {
							stderr += chunk;
						});
						proc.stderr.on("end", () => {
							reject(new Error(`[ripgrep] tar failed (${code}): ${stderr}`));
						});
					} else {
						reject(new Error(`[ripgrep] tar failed (${code})`));
					}
				} else {
					resolve();
				}
			});
		});
		if (!(await fileExists(binPath))) {
			throw new Error(`[ripgrep] ${basename(binPath)} not found after extraction`);
		}
		if (!isWin) {
			await new Promise<void>((resolve, reject) => {
				const ch = spawn("chmod", ["755", binPath], { stdio: "ignore" });
				ch.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`chmod failed: ${code}`))));
			});
		}
		return binPath;
	} finally {
		await rm(tmpFile, { force: true }).catch(() => {});
	}
}
