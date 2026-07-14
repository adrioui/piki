import { spawn } from "node:child_process";
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTarget, getVersion, isWindows } from "./platform.ts";
import { rgPath } from "./rg-embed.ts";

const BIN_DIR = join(homedir(), ".piki", "bin");
const VERSION_MARKER = join(BIN_DIR, "rg.version");

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function getRgBinPath(): string {
	return join(BIN_DIR, isWindows() ? "rg.exe" : "rg");
}

function versionString(): string {
	const target = getTarget();
	return `${getVersion(target)}|${target}`;
}

async function versionMatches(): Promise<boolean> {
	try {
		return (await readFile(VERSION_MARKER, "utf-8")).trim() === versionString();
	} catch {
		return false;
	}
}

async function getEmbeddedRgPath(): Promise<string> {
	return rgPath;
}

async function extractEmbedded(): Promise<string> {
	const embeddedPath = await getEmbeddedRgPath();
	if (!(await fileExists(embeddedPath))) {
		throw new Error(
			"[ripgrep] Packaging invariant violated: ripgrep binary not found. This binary was built incorrectly.",
		);
	}
	await mkdir(BIN_DIR, { recursive: true });
	const binPath = getRgBinPath();
	const data = await readFile(embeddedPath);
	await writeFile(binPath, data);
	if (!isWindows()) {
		await new Promise<void>((resolve, reject) => {
			const proc = spawn("chmod", ["755", binPath], { stdio: "ignore" });
			proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`chmod failed: ${code}`))));
		});
	}
	await writeFile(VERSION_MARKER, versionString());
	return binPath;
}

let cachedPath: string | null = null;
let resolvePromise: Promise<string> | null = null;

export async function resolveRgPath(): Promise<string> {
	if (cachedPath) return cachedPath;
	const binPath = getRgBinPath();
	if ((await fileExists(binPath)) && (await versionMatches())) {
		cachedPath = binPath;
		return binPath;
	}
	if (!resolvePromise) {
		resolvePromise = extractEmbedded()
			.then((path) => {
				cachedPath = path;
				return path;
			})
			.finally(() => {
				resolvePromise = null;
			});
	}
	return resolvePromise;
}

export { getRgBinPath, fileExists };
