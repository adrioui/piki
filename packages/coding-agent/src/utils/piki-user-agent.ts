export function getPikiUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `piki/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

export const getPiUserAgent = getPikiUserAgent;
